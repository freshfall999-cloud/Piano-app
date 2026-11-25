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
- `musc_small.onnx` / `musc_small.json` / `musc_vocab.json` — MuScriptor (Kyutai and Mirelo, 2026; code MIT): the small
  model's transformer as an ONNX graph that holds **no weights** (each weight refers by name to the tensor of the same
  name in the official, gated `model.safetensors`, which each user downloads with their own Hugging Face token), and
  the MT3 token vocabulary. The weights are CC BY-NC 4.0 and are never part of this repository.
- `tkaug_*` — Transkun V2 Aug (Yujia Yan; MIT), the V2 checkpoint trained with data augmentation, from the author's
  model card (github.com/Yujia-Yan/Transkun), converted the same way as `transkun_*` (its own analysis windows).
- `htdemucs6s_piano.*` — Demucs v4 `htdemucs_6s` (Hybrid Transformer Demucs, 6 sources; Alexandre Défossez / Meta,
  MIT, see LICENSE-demucs; weights from dl.fbaipublicfiles.com). Converted without its STFT / inverse STFT (done in
  `onnx-worker.js`) and with only the piano source as output. In the browser, with Demucs' own 7.8 s pieces, 25%
  overlap and triangular blending, it matches the original (correlation 1.00000, 54 dB) on a 20 s test mix.
- `ymt3_encoder.*`, `ymt3_decoder.*`, `ymt3_vocab.json` — YourMT3+ (YPTF.MoE+Multi, noPS) by Sungkyun Chang, Emmanouil
  Benetos, Holger Kirchhoff and Simon Dixon (MLSP 2024, arXiv:2407.04822); weights Apache-2.0
  (huggingface.co/mimbres/YourMT3). Taken from the unofficial ONNX export huggingface.co/ONLY4DarkKnight/YourMT3-plus-onnx
  (Apache-2.0, see NOTICE-ymt3.md) and stored as 16-bit floats. Trained partly on non-commercial datasets.
