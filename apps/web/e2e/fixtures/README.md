# Video fixtures

The dimension-named WebM clips contain 14 opaque green/blue VP8 frames at 20 fps
(0.7 seconds). The audio variant includes a 440 Hz, mono 48 kHz Opus tone. They
were encoded with Chromium WebCodecs and muxed with Mediabunny 1.61.5. Fixed
samples avoid MediaRecorder occasionally producing no picture packets under
concurrent headless load. Tests still exercise the actual browser compressor.

`empty-video-track.webm` is MediaRecorder output that declares a VP8 picture
track with no packets alongside a valid Opus track. It reproduces conversion
silently producing audio only, which must retain the original instead.

`videoFixture` can append a valid 1.1 MB Matroska Void element to cross the
compression threshold without depending on codec bitrate or host timing.
