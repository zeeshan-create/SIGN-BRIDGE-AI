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
  }
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

    console.log(`[Server] Processing video: ${req.file.path}`);
    
    // Resolve absolute path to be sent to Python
    const absolutePath = path.resolve(req.file.path);

    // Notify the frontend instantly so UI shifts into stream mode
    res.json({
        message: 'Video uploaded successfully',
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size
    });

    // Start video processing asynchronously
    if (!pythonProcess) {
       pendingVideo = absolutePath;
       startPythonBridge();
    } else if (pythonSocket && pythonReady) {
       pythonSocket.emit("process_video", absolutePath);
    } else {
       pendingVideo = absolutePath;
    }
});

let pythonProcess = null;
let pythonSocket = null;
let pythonReady = false;
let pendingStart = false;
let pendingVideo = null;

// Session History State
let sessionHistory = [];
let currentSentenceId = 0;

function startPythonBridge() {
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
    if (output.includes("Running on port")) {
      setTimeout(connectToPython, 1000);
    }
  });

  pythonProcess.stderr.on("data", (data) => console.error(`[Python Error] ${data}`));

  pythonProcess.on("close", (code) => {
    console.log(`[Server] Python bridge closed with code ${code}`);
    pythonReady = false;
    pythonSocket = null;
    pythonProcess = null;
  });
}

function connectToPython() {
  if (pythonSocket) return;
  console.log("[Server] Connecting to Python bridge...");
  pythonSocket = socketIoClient("http://127.0.0.1:5001", { transports: ["websocket"] });

  pythonSocket.on("connect", () => {
    console.log("[Server] Connected to Python bridge");
    pythonReady = true;
    
    if (pendingVideo) {
      console.log(`[Server] Executing pending video processing: ${pendingVideo}`);
      pythonSocket.emit("process_video", pendingVideo);
      pendingVideo = null;
      pendingStart = false; // Override start stream if a video was pending
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
    if (!pythonProcess) {
       pendingStart = true;
       startPythonBridge();
    } else if (pythonSocket && pythonReady) {
       pythonSocket.emit("start_stream");
    } else {
       pendingStart = true;
    }
    socket.emit("stream_status", { status: "active" });
  });
  socket.on("stop_detection", () => {
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] SignBridge Backend running on http://localhost:${PORT}`);
});