"""
SignBridge AI - Python-Node Bridge
==================================
This script wraps the core ASLInterpreter logic for high-performance
communication with the Node.js professional backend.

DO NOT MODIFY src/real_time_detection.py
"""

import eventlet
eventlet.monkey_patch()

import sys
import os
import json
import cv2
import base64
import time
import socketio
from eventlet import listen, wsgi

# Add src to path to import original logic
sys.path.append(os.path.join(os.path.dirname(__file__), "src"))
from real_time_detection import ASLInterpreter, CameraStream

# Initialize the ORIGINAL logic
interpreter = ASLInterpreter()
camera = None
active = False

sio = socketio.Server(cors_allowed_origins="*")
app = socketio.WSGIApp(sio)


@sio.event
def connect(sid, environ):
    print(f"[Python Bridge] Connected: {sid}")


@sio.on("start_stream")
def start_stream(sid):
    global camera, active
    if not active:
        print("[Python Bridge] Initializing camera hardware...")
        camera = CameraStream(0)
        active = True
        eventlet.spawn(detection_loop)
        return {"status": "success"}


@sio.on("stop_stream")
def stop_stream(sid):
    global camera, active
    active = False
    if camera:
        camera.release()
    camera = None
    print("[Python Bridge] Camera released.")
    return {"status": "stopped"}


@sio.on("process_video")
def process_video(sid, file_path):
    global camera, active
    if active:
        active = False
        if camera:
            camera.release()
        camera = None
    
    print(f"[Python Bridge] Processing video file: {file_path}")
    active = True
    eventlet.spawn(video_loop, file_path)
    return {"status": "started"}


@sio.on("set_mode")
def set_mode(sid, mode):
    global interpreter
    mode = mode.upper()
    if mode in interpreter.MODES:
        interpreter.mode = mode
        interpreter.mode_idx = interpreter.MODES.index(mode)
        interpreter.history.clear()
        print(f"[Python Bridge] Mode set to: {mode}")


@sio.on("clear_sentence")
def clear_sentence(sid):
    global interpreter
    interpreter.sentence.clear()
    interpreter.history.clear()
    interpreter.current_word.clear()


@sio.on("manual_input")
def manual_input(sid, character):
    global interpreter
    character = character.upper()

    # Handle backspace
    if character == "\b":
        if len(interpreter.current_word) > 0:
            interpreter.current_word.pop()
        elif len(interpreter.sentence) > 0:
            interpreter.current_word = list(interpreter.sentence.pop())
        interpreter.last_pred = ""
    else:
        interpreter.last_pred = character
        interpreter.history.append(character)

        if len(interpreter.history) >= interpreter.history_length:
            interpreter.history.pop(0)

        if character == " ":
            if len(interpreter.current_word) > 0:
                interpreter.sentence.append("".join(interpreter.current_word))
                interpreter.current_word = []
        else:
            interpreter.current_word.append(character)

    current_sentence = (
        " ".join(interpreter.sentence)
        + (" " if interpreter.sentence else "")
        + "".join(interpreter.current_word)
    )

    sio.emit(
        "prediction",
        {
            "sign": interpreter.last_pred or "---",
            "sentence": current_sentence.strip(),
            "mode": interpreter.mode,
            "fps": 0,
            "image": "",
        },
    )


def detection_loop():
    global camera, active, interpreter
    print("[Python Bridge] Detection loop started")
    while active:
        if camera is None:
            print("[Python Bridge] Camera is None")
            break

        ret, frame = camera.read()
        if not ret or frame is None:
            print("[Python Bridge] Camera read failed")
            eventlet.sleep(0.01)
            continue

        print("[Python Bridge] Processing frame")
        frame = cv2.flip(frame, 1)
        # Call the ORIGINAL logic
        processed_frame = interpreter.process_frame(frame)

        # Encode result
        _, buffer = cv2.imencode(".jpg", processed_frame)
        frame_base64 = base64.b64encode(buffer).decode("utf-8")

        current_sign = interpreter.history[-1] if interpreter.history else "---"
        current_sentence = " ".join(interpreter.sentence)

        print(
            f"[Python Bridge] Sending: sign={current_sign}, sentence={current_sentence}"
        )
        # Send data back to Node server
        sio.emit(
            "ai_result",
            {
                "image": frame_base64,
                "sign": current_sign,
                "sentence": current_sentence,
                "fps": round(interpreter._calculate_fps(), 1),
                "mode": interpreter.mode,
            },
        )
        eventlet.sleep(0.01)

def video_loop(file_path):
    global active, interpreter
    print("[Python Bridge] Video loop started")
    cap = cv2.VideoCapture(file_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    delay = 1.0 / fps

    while active:
        ret, frame = cap.read()
        if not ret or frame is None:
            print("[Python Bridge] Video EOF reached")
            break

        print("[Python Bridge] Processing video frame")
        # Ensure consistency with how CameraStream inputs are flipped
        frame = cv2.flip(frame, 1)
        
        processed_frame = interpreter.process_frame(frame)

        # Encode result
        _, buffer = cv2.imencode(".jpg", processed_frame)
        frame_base64 = base64.b64encode(buffer).decode("utf-8")

        current_sign = interpreter.history[-1] if interpreter.history else "---"
        current_sentence = " ".join(interpreter.sentence)

        sio.emit(
            "ai_result",
            {
                "image": frame_base64,
                "sign": current_sign,
                "sentence": current_sentence,
                "fps": round(fps, 1),
                "mode": interpreter.mode,
            },
        )
        # Sleep exactly the delay required to maintain original video pacing
        eventlet.sleep(delay)

    cap.release()
    active = False


if __name__ == "__main__":
    # Internal port for Node talk
    print("[Python Bridge] Running on port 5001...")
    wsgi.server(eventlet.listen(("127.0.0.1", 5001)), app)
