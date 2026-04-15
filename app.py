"""
SIGNBRIDGE AI - Unified Professional Platform
==============================================
Landing Page + Real-time Interpreter Engine
"""

from flask import Flask, render_template, Response, jsonify
from flask_socketio import SocketIO, emit
import cv2
import threading
import time
import os
import sys

# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), "src"))
from real_time_detection import ASLInterpreter, CameraStream

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

class GlobalState:
    def __init__(self):
        self.interpreter = ASLInterpreter()
        self.camera = None
        self.latest_frame = None
        self.camera_active = False
        self.running = True
        self._thread = None

    def start_camera(self):
        if not self.camera_active:
            print("[System] Initializing camera hardware...")
            try:
                self.camera = CameraStream(0)
                self.camera_active = True
                if self._thread is None or not self._thread.is_alive():
                    self._thread = threading.Thread(target=detection_loop, daemon=True)
                    self._thread.start()
                return True
            except Exception as e:
                print(f"[Error] Camera init failed: {e}")
                return False
        return False

    def stop_camera(self):
        self.camera_active = False
        if self.camera:
            self.camera.release()
        self.camera = None
        self.latest_frame = None
        return True

state = GlobalState()

def detection_loop():
    while state.running:
        if not state.camera_active or state.camera is None:
            time.sleep(0.5)
            continue
            
        ret, frame = state.camera.read()
        if not ret or frame is None:
            time.sleep(0.01)
            continue
            
        frame = cv2.flip(frame, 1)
        processed_display = state.interpreter.process_frame(frame)
        state.latest_frame = processed_display
        
        current_sign = state.interpreter.history[-1] if (state.interpreter.history and state.interpreter.history[-1]) else "---"
        current_sentence = " ".join(state.interpreter.sentence)
        
        socketio.emit('detection_update', {
            'sign': current_sign,
            'sentence': current_sentence,
            'fps': round(state.interpreter._calculate_fps(), 1),
            'mode': state.interpreter.mode,
            'camera_active': state.camera_active
        })
        time.sleep(0.01)

# --- Routes ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/demo')
def demo():
    return render_template('demo.html')

def gen_frames():
    while True:
        if state.camera_active and state.latest_frame is not None:
            ret, buffer = cv2.imencode('.jpg', state.latest_frame)
            if not ret: continue
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        else:
            time.sleep(0.2)

@app.route('/video_feed')
def video_feed():
    return Response(gen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

# --- Socket Events ---

@socketio.on('toggle_camera')
def handle_camera():
    if state.camera_active: state.stop_camera()
    else: state.start_camera()
    emit('status_update', {'camera_active': state.camera_active}, broadcast=True)

@socketio.on('set_mode')
def handle_set_mode(mode_name):
    """Sets the interpreter mode directly (ALPHABET, WORDS, or ALL)."""
    mode_name = mode_name.upper()
    if mode_name in state.interpreter.MODES:
        state.interpreter.mode = mode_name
        state.interpreter.mode_idx = state.interpreter.MODES.index(mode_name)
        state.interpreter.history.clear()
        print(f"[System] Mode manually set to: {mode_name}")
        emit('mode_updated', {'mode': state.interpreter.mode}, broadcast=True)

@socketio.on('toggle_mode')
def handle_toggle():
    state.interpreter.toggle_mode()
    emit('mode_updated', {'mode': state.interpreter.mode}, broadcast=True)

@socketio.on('clear_sentence')
def handle_clear():
    state.interpreter.sentence.clear()
    state.interpreter.history.clear()
    emit('detection_update', {
        'sign': "---",
        'sentence': "",
        'fps': 0,
        'mode': state.interpreter.mode,
        'camera_active': state.camera_active
    }, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, host='127.0.0.1', port=5000, debug=False)
