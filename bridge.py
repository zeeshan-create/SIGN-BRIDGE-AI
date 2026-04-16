import sys
import os
import json
import cv2
import base64
import time
import threading
from flask import Flask
from flask_socketio import SocketIO
from pathlib import Path

# --- Absolute Path Configuration ---
BASE_DIR = Path(__file__).resolve().parent
SRC_DIR = BASE_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))

# --- Import Shield ---
try:
    from real_time_detection import ASLInterpreter, CameraStream
except ImportError as e:
    print(f"\n[CRITICAL ERROR] Failed to import ASL modules from {SRC_DIR}: {e}")
    sys.exit(1)

# Initialize Flask & SocketIO
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', ping_timeout=60, ping_interval=25)

# Global State
interpreter = ASLInterpreter()
camera = None
active = False
lock = threading.Lock()

@socketio.on('connect')
def handle_connect():
    print(f"[Python Bridge] Client connected")

@socketio.on('start_stream')
def start_stream():
    global camera, active
    with lock:
        if not active:
            print("[Python Bridge] Initializing camera hardware...")
            try:
                camera = CameraStream(0)
                if not camera.is_opened:
                    print("[Python Bridge] Camera 0 failed, trying index 1...")
                    camera = CameraStream(1)
                
                if not camera.is_opened:
                    raise Exception("No hardware camera detected.")
                    
                active = True
                # Start AI Loop in background
                t = threading.Thread(target=detection_loop, name="AI_Worker", daemon=True)
                t.start()
                print("[Python Bridge] AI Worker started.")
                return {"status": "success"}
            except Exception as e:
                print(f"[Python Bridge] Camera Error: {e}")
                active = False
                return {"status": "error", "message": str(e)}
        return {"status": "already_active"}

@socketio.on('stop_stream')
def stop_stream():
    global active, camera
    with lock:
        active = False
        if camera:
            camera.release()
        camera = None
    print("[Python Bridge] Stream stopped.")
    return {"status": "stopped"}

@socketio.on('set_mode')
def set_mode(data):
    global interpreter
    mode = data.upper() if isinstance(data, str) else data.get('mode', 'ALL').upper()
    if mode in interpreter.MODES:
        interpreter.mode = mode
        interpreter.mode_idx = interpreter.MODES.index(mode)
        interpreter.history.clear()
        print(f"[Python Bridge] Mode -> {mode}")

def detection_loop():
    global camera, active, interpreter
    print("[Python Bridge] AI Loop entering frame cycle...")
    
    while active:
        if camera is None: break
        
        try:
            ret, frame = camera.read()
            if not ret or frame is None:
                time.sleep(0.01)
                continue
            
            frame = cv2.flip(frame, 1)
            processed_frame = interpreter.process_frame(frame)
            
            # Encode for transfer
            _, buffer = cv2.imencode(".jpg", processed_frame, [cv2.IMWRITE_JPEG_QUALITY, 55])
            frame_base64 = base64.b64encode(buffer).decode("utf-8")
            
            current_sign = interpreter.history[-1] if interpreter.history else "---"
            current_sentence = " ".join(interpreter.sentence)
            
            # Emit results directly using socketio.emit
            socketio.emit('ai_result', {
                "image": frame_base64,
                "sign": current_sign,
                "sentence": current_sentence,
                "fps": round(interpreter._calculate_fps(), 1),
                "mode": interpreter.mode
            })
            
        except Exception as e:
            print(f"[Python Bridge] Loop Crash Avoided: {e}")
            
        time.sleep(0.01) # Power safety

@socketio.on('clear_sentence')
def handle_clear():
    interpreter.sentence.clear()
    interpreter.history.clear()

if __name__ == "__main__":
    print("[Python Bridge] Stabilized Flask-SocketIO Server starting on 5001...")
    # Using allow_unsafe_werkzeug=True for high-stability standard threading on Windows
    socketio.run(app, host='127.0.0.1', port=5001, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)
