# Third-party notices

Keyfall's own code is in the repository root (`app.js`, `index.html`, `style.css`, `songs.js`, `sound.js`, the
`*-worker.js` files, `listen-ml.js`, `oaf.html`). Everything below was made by others and is used under its licence.
Nothing here is sold or used commercially: Keyfall is a free, non-commercial app.

## Music

The built-in songs (`songs.js`) are all public-domain melodies (traditional tunes, Bach, Beethoven, Brahms,
Pachelbel, Petzold, J. Pierpont's "Jingle Bells" of 1857, "Happy Birthday" / "Good Morning to All"), written out
for this app. Songs a person adds (MIDI files or recordings) are turned into notes on their own device and stay
there: they are never uploaded or published.

## Sound

- **Salamander Grand Piano V3** by Alexander Holm — piano samples in `samples/`. Licence: Creative Commons
  Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). Converted to MP3 and renamed; see
  `samples/CREDITS.md`.

## Graphics

- **three.js** r170 by the three.js authors — `vendor/three/three.module.min.js`, used for the 3D sparkles when you hit a
  note (`fx3d.js`). Licence: MIT (`vendor/three/LICENSE`).

## Note-finding models and libraries

| What | Where | By | Licence |
|---|---|---|---|
| TensorFlow.js (and its WebAssembly back-end) | `vendor/tf*.js`, `vendor/tfjs-*.wasm` | Google LLC | Apache 2.0 |
| Basic Pitch model and code | `vendor/basic-pitch/` | Spotify AB | Apache 2.0 (`vendor/basic-pitch/LICENSE`) |
| Magenta.js and the Onsets and Frames checkpoint | `vendor/magenta/` | Google LLC | Apache 2.0 (`vendor/magenta/LICENSE`) |
| ONNX Runtime Web 1.22.0 | `vendor/ort/` | Microsoft Corporation | MIT (`vendor/ort/LICENSE`) |
| High-resolution piano transcription: note-processing code ported to JavaScript in `onnx-worker.js` | — | Qiuqiang Kong et al. (ByteDance), github.com/bytedance/piano_transcription | Apache 2.0 |
| ByteDance note-model and pedal-model weights, converted to ONNX with 16-bit weights (the pedal model's post-processing ported to JavaScript in `onnx-worker.js`) | `vendor/models/bytedance.*`, `vendor/models/bytedance_pedal.*` | Qiuqiang Kong et al., zenodo.org/records/4034264 | CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) |
| The same network re-trained for robustness, converted to ONNX with 16-bit weights | `vendor/models/qmul.*` | Drew Edwards, Simon Dixon, Emmanouil Benetos, Akira Maezawa, Yuta Kusaka (Queen Mary University of London, Yamaha), zenodo.org/records/10610212 | CC BY 4.0 |
| Transkun 2.0 code (decoding ported to JavaScript in `onnx-worker.js`) and weights (V2 as shipped, and V2 Aug), converted to ONNX with 16-bit weights | `vendor/models/transkun_*`, `vendor/models/tkaug_*` | Yujia Yan, Zhiyao Duan | MIT (`vendor/models/LICENSE-transkun`) |
| hFT-Transformer code (note extraction ported to JavaScript in `onnx-worker.js`) | — | Sony Group Corporation, github.com/sony/hFT-Transformer | MIT (`vendor/models/LICENSE-sony-code`) |
| hFT-Transformer weights, converted to ONNX with 16-bit weights | `vendor/models/sony.*` | Copyright (c) 2023 Sony Group Corporation | **CC BY-NC-SA 4.0** (https://creativecommons.org/licenses/by-nc-sa/4.0/): non-commercial use only; this converted copy is shared under the same licence |

| Demucs v4 htdemucs_6s (piano source), converted to ONNX with 16-bit weights; its STFT, inverse STFT and segment blending ported to JavaScript in `onnx-worker.js` | `vendor/models/htdemucs6s_piano.*` | Meta Platforms (Alexandre Défossez), github.com/facebookresearch/demucs | MIT (`vendor/models/LICENSE-demucs`) |
| YourMT3+ (YPTF.MoE+Multi noPS): the unofficial ONNX export, stored with 16-bit weights; decoding loop and the authors' token → note code (event2note / note2event) ported to JavaScript in `ymt3-worker.js` | `vendor/models/ymt3_*` | Sungkyun Chang, Emmanouil Benetos, Holger Kirchhoff, Simon Dixon (huggingface.co/mimbres/YourMT3); export: huggingface.co/ONLY4DarkKnight/YourMT3-plus-onnx | Apache 2.0 (`vendor/models/NOTICE-ymt3.md`); trained partly on non-commercial datasets |
| MuScriptor: inference loop and token decoding ported to JavaScript in `musc-worker.js`; the model's structure as an ONNX graph **without weights** (`vendor/models/musc_small.onnx`) and its token vocabulary (`musc_vocab.json`) | `musc-worker.js`, `vendor/models/musc_*` | Kyutai and Mirelo, github.com/muscriptor/muscriptor | MIT (code) |
| MuScriptor weights | **not included** | Kyutai and Mirelo, huggingface.co/MuScriptor | CC BY-NC 4.0, gated: each person downloads them with their own Hugging Face account after accepting the licence, straight to their own device |

The full Apache License 2.0 text is in `LICENSE-APACHE-2.0.txt`. Changes made to the models: converted from
PyTorch to ONNX, weights stored as 16-bit floats, and (Transkun) split into three parts; the code around them was
rewritten in JavaScript. Details in `vendor/models/README.md`.

If Keyfall is ever sold, shows ads or is otherwise used commercially, the Sony model (`vendor/models/sony.*`) must
be removed first.
