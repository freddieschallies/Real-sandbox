# Instruction videos

One captioned video per position, shown in the app under "How to use the app" (served by the
server from `server/help-videos/`). They are recorded from the test drive with a made-up company
("Coastline Cooling"), so they hold no real data.

To make them again after the app changes:

1. `SP=/some/scratch bash src/build-video.sh` builds the test drive under the made-up company into `$SP/video/plain.html`.
2. Copy `src/*` into `$SP/video/` and run each `python3 v_<position>.py` there (Playwright with Chromium).
3. Compress: `ffmpeg -i out/<name>.mp4 -c:v libx264 -crf 27 -pix_fmt yuv420p -movflags +faststart <name>.mp4`
   and put them in `server/help-videos/`.
