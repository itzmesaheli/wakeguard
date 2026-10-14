WakeGuard

A driver-drowsiness alert that runs entirely in the browser (HTML, CSS, JavaScript, no backend). It uses the webcam and MediaPipe Face Mesh to watch your eyes, mouth and head, and sounds an alarm before you fall asleep.

This is a learning project, not a safety device.

Features
Eye-closure, yawn, head-nod and looking-away detection, with a fatigue score
Guided calibration, low-light and sunglasses warning
Escalating alarm, "I'm awake" voice command (Chrome)
Pre-trip check, driving-time break reminder
Safe driving score, streaks, weekly summary, blink analysis, time-of-day heatmap
Accuracy test (mark alarms real or false)
Printable trip report, WhatsApp share, backup and restore
Several drivers, Hindi and Bengali interface and voice, large text, colour-blind palette
Installable as an app (PWA), works offline after first load
Run it

The camera needs https or localhost:

python -m http.server 8000

Then open http://localhost:8000

Files

index.html, style.css, app.js, i18n.js (translations), sw.js, manifest.webmanifest, icons. Add your own bg.jpg (background image) and optionally alarm.mp3.

Privacy

Video is processed in your browser and never uploaded. Settings and history are stored only in your browser.
