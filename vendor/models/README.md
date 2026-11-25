Converted piano transcription models (PyTorch → ONNX, weights stored as 16-bit floats):

- `bytedance.*` — "High-resolution Piano Transcription with Pedals by Regressing Onsets and Offsets Times",
  Qiuqiang Kong et al. (ByteDance), 2020. Code: Apache License 2.0 (github.com/bytedance/piano_transcription,
  piano_transcription_inference). Weights: zenodo.org/records/4034264, CC BY 4.0. Only the note model is included.
- `transkun_*` — Transkun 2.0 by Yujia Yan and Zhiyao Duan (MIT License, see LICENSE-transkun). The network is split
  into the feature context (`transkun_ctx`), the interval scorer (`transkun_score`) and the velocity/offset heads
  (`transkun_attr`); `transkun_windows.f32` and `transkun_mel.json` are its analysis windows and mel filter bank.
- `qmul.*` — the ByteDance network above re-trained with data augmentation for robustness to other pianos and rooms:
  Drew Edwards, Simon Dixon, Emmanouil Benetos, Akira Maezawa and Yuta Kusaka, "A Data-Driven Analysis of Robust
  Automatic Piano Transcription", IEEE Signal Processing Letters, 2024. Weights: zenodo.org/records/10610212, CC BY 4.0.
- `sony.*` — hFT-Transformer by Keisuke Toyama et al. (Sony), ISMIR 2023, github.com/sony/hFT-Transformer. Code: MIT.
  Weights (and this converted copy of them): Copyright (c) 2023 Sony Group Corporation, CC BY-NC-SA 4.0
  (creativecommons.org/licenses/by-nc-sa/4.0/), trained on MAESTRO v3.0.0: non-commercial use only, share alike.
  `sony_mel.json` is torchaudio's mel filter bank for its input (16 kHz, 2048-point FFT, 256 bands, Slaney norm).
