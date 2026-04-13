# ASL Detection System (Antigravity-Solutions)

A professional-grade, real-time American Sign Language (ASL) interpreter using MediaPipe and TensorFlow Lite.

## 🚀 Key Features
- **35+ Sign Vocabulary**: Supports the full ASL Alphabet (A-Y) and common expressions (Eat, Who, Why, Listen, Hello, Yes, No, etc.).
- **Balanced Neural Engine**: Trained on 144,000+ samples with oversampling to ensure zero bias and high recall.
- **Categorical Masking**: Strict mode-switching between Alphabet and Word modes to prevent prediction shadowing.
- **Stabilized Hud**: Jitter-free hand skeleton tracking with adaptive smoothing and an interactive glassmorphism UI.
- **Zero Latency**: Multi-threaded camera pipeline for real-time inference.

## 🛠️ Usage
1. **Run the Interpreter**:
   ```bash
   python src/real_time_detection.py
   ```
2. **Controls**:
   - `M`: Toggle Mode (All / Alphabet / Words)
   - `C`: Clear History
   - `Q`: Quit

## 📂 Project Structure
- `src/`: Core Python source code.
- `models/`: Trained TFLite engine and label maps.
- `asl_posters/`: High-resolution demonstration posters for presentation.
- `processed_data/`: (Excluded) Landmark training vectors.

## 🎓 Faculty Demonstration
Posters for the demonstration can be found in the `/asl_posters` directory. The system includes real-time diagnostics (top-3 predictions) for complete transparency during the presentation.
