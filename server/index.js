require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { spawn } = require("child_process");
const { io: socketIoClient } = require("socket.io-client");
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const JWT_SECRET = process.env.JWT_SECRET || 'signbridge_elite_secret_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const gClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const USERS_FILE = path.join(__dirname, 'users.json');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });

const getUsers = () => {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return [];
};

const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// --- Auth Routes ---
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const users = getUsers();
    if (users.find(u => u.email === email)) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = users.length === 0 ? 'admin' : 'user';
    const newUser = { id: Date.now(), name, email, password: hashedPassword, role };
    users.push(newUser);
    saveUsers(users);

    const token = jwt.sign({ id: newUser.id, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: newUser.id, name, email, role } });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.email === email);
    if (!user) return res.status(400).json({ message: 'User not found' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/google', async (req, res) => {
    const { token: googleToken } = req.body;
    try {
        const ticket = await gClient.verifyIdToken({
            idToken: googleToken,
            audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { email, name, sub: googleId } = payload;
        
        let users = getUsers();
        let user = users.find(u => u.email === email);
        
        if (!user) {
            const role = users.length === 0 ? 'admin' : 'user';
            user = { id: Date.now(), name, email, googleId, role, image: payload.picture };
            users.push(user);
            saveUsers(users);
        } else if (!user.googleId) {
            user.googleId = googleId;
            user.image = payload.picture;
            saveUsers(users);
        }
        
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, image: user.image } });
    } catch (err) {
        console.error('[Auth] Google verify error:', err);
        res.status(401).json({ message: 'Invalid Google token' });
    }
});

// --- Video Upload Route ---
app.post('/api/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No video file uploaded' });

    const startFrame = req.body.startFrame ? parseInt(req.body.startFrame, 10) : 0;
    console.log(`[Server] Processing video: ${req.file.path} (startFrame: ${startFrame})`);
    
    // Resolve absolute path to be sent to Python
    const absolutePath = path.resolve(req.file.path);

    // Notify the frontend instantly so UI shifts into stream mode
    res.json({
        message: 'Video uploaded successfully',
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        startFrame: startFrame
    });

    // Start video processing asynchronously with start position
    if (!pythonProcess) {
       pendingVideo = absolutePath;
       pendingStartFrame = startFrame;
       startPythonBridge();
    } else if (pythonSocket && pythonReady) {
       pythonSocket.emit("process_video", { path: absolutePath, startFrame: startFrame });
    } else {
       pendingVideo = absolutePath;
       pendingStartFrame = startFrame;
    }
});

let pythonProcess = null;
let pythonSocket = null;
let pythonReady = false;
let pendingStart = false;
let pendingVideo = null;
let pendingStartFrame = 0;

// Session History State
let sessionHistory = [];
let currentSentenceId = 0;

function startPythonBridge() {
  console.log("[Server] Cleaning legacy ports...");
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
       // Search for process on 5001 and kill it
       const output = execSync('netstat -ano | findstr :5001').toString();
       const lines = output.split('\n');
       for (const line of lines) {
         if (line.includes('LISTENING')) {
           const pid = line.trim().split(/\s+/).pop();
           console.log(`[Server] Terminating zombie process on 5001 (PID: ${pid})`);
           execSync(`taskkill /F /PID ${pid}`);
         }
       }
    }
  } catch (e) {
    // Port might be clean already, ignore error
  }

  console.log("[Server] Starting Python bridge...");
  pythonProcess = spawn("python", ["-u", "bridge.py"], {
    cwd: path.join(__dirname, '..'),
    shell: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  // Fallback: connect anyway after 5 seconds if we miss the log
  setTimeout(connectToPython, 5000);

  pythonProcess.stdout.on("data", (data) => {
    const output = data.toString();
    console.log(`[Python] ${output}`);
    
    // Immediate connection if bridge says it's ready
    if (output.includes("Running on port 5001") || output.includes("initialized")) {
      console.log("[Server] Sync Signal: Python bridge is ready. Connecting...");
      setTimeout(connectToPython, 500);
    }
  });

  pythonProcess.stderr.on("data", (data) => {
    const errorMsg = data.toString();
    console.error(`[Python Error] ${errorMsg}`);
    
    if (errorMsg.includes("CRITICAL ERROR") || errorMsg.includes("ImportError")) {
       console.error("[Server] DETECTED CRITICAL PYTHON FAILURE. Check bridge setup.");
    }
  });

  pythonProcess.on("close", (code) => {
    console.log(`[Server] Python bridge closed with code ${code}`);
    pythonReady = false;
    pythonSocket = null;
    pythonProcess = null;
    // Only auto-restart on unexpected crash (not clean exit)
    if (code !== 0 && code !== null) {
      console.log("[Server] Bridge crashed — reconnecting to existing instance...");
      setTimeout(connectToPython, 2000);
    }
  });
}

function connectToPython() {
  if (pythonSocket) return;
  console.log("[Server] Connecting to Python bridge...");
  pythonSocket = socketIoClient("http://127.0.0.1:5001", { 
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: 10
  });

  pythonSocket.on("connect", () => {
    console.log("[Server] Connected to Python bridge");
    pythonReady = true;
    
    if (pendingVideo) {
      console.log(`[Server] Executing pending video processing: ${pendingVideo} (startFrame: ${pendingStartFrame})`);
      pythonSocket.emit("process_video", { path: pendingVideo, startFrame: pendingStartFrame });
      pendingVideo = null;
      pendingStartFrame = 0;
      pendingStart = false;
    } else if (pendingStart) {
      console.log("[Server] Executing pending stream start...");
      pythonSocket.emit("start_stream");
      pendingStart = false;
    }
  });

  pythonSocket.on("disconnect", () => {
    console.log("[Server] Disconnected from Python bridge");
    pythonReady = false;
  });

pythonSocket.on("connect_error", (err) => {
    console.log("[Server] Python connection error:", err.message);
  });

  pythonSocket.on("ai_result", (data) => {
    io.emit("prediction", data);
    
    if (data.sentence && data.sentence.trim().length > 0) {
      let currentLog = sessionHistory.find(h => h.id === currentSentenceId);
      if (currentLog) {
        if (currentLog.sentence !== data.sentence) {
          currentLog.sentence = data.sentence;
          io.emit("history_updated", sessionHistory);
        }
      } else {
        sessionHistory.push({ id: currentSentenceId, sentence: data.sentence });
        io.emit("history_updated", sessionHistory);
      }
    }
  });
}

// Cleanup Python process when Node exits
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    console.log(`[Server] Received ${signal}, killing Python bridge...`);
    if (pythonProcess) pythonProcess.kill();
    process.exit();
  });
});

io.on("connection", (socket) => {
  console.log("[Server] Client connected:", socket.id);
  socket.on("start_detection", () => {
    console.log("[Server] Received start_detection");
    if (!pythonProcess) {
       console.log("[Server] Python process not started, starting...");
       pendingStart = true;
       startPythonBridge();
    } else if (pythonSocket && pythonReady) {
       console.log("[Server] Python ready, emitting start_stream");
       pythonSocket.emit("start_stream");
    } else {
       console.log("[Server] Python not ready, setting pendingStart");
       pendingStart = true;
    }
    socket.emit("stream_status", { status: "active" });
  });
  socket.on("stop_detection", () => {
    console.log("[Server] Received stop_detection");
    if (pythonSocket && pythonReady) pythonSocket.emit("stop_stream");
    socket.emit("stream_status", { status: "stopped" });
  });
  socket.on("set_mode", (mode) => {
    if (pythonSocket && pythonReady) pythonSocket.emit("set_mode", mode);
  });
  socket.on("clear_sentence", () => {
    if (pythonSocket && pythonReady) pythonSocket.emit("clear_sentence");
    currentSentenceId++; // Move new sentences to a new line in history
  });
  
  socket.on("clear_history", () => {
    sessionHistory = [];
    currentSentenceId++;
    io.emit("history_updated", sessionHistory);
  });

  socket.on("get_history", () => {
    socket.emit("history_updated", sessionHistory);
  });
  
  socket.on("manual_input", (character) => {
    if (pythonSocket && pythonReady) pythonSocket.emit("manual_input", character);
  });
});

startPythonBridge();

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] SignBridge Backend running on http://localhost:${PORT}`);
});