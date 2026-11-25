# NOTICE

This repository contains an **unofficial ONNX export** of YourMT3+ (checkpoint YPTF.MoE+Multi, noPS:
`mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/last.ckpt`).

- Original model: YourMT3+ by Sungkyun Chang, Emmanouil Benetos, Holger Kirchhoff, Simon Dixon
  (MLSP 2024, arXiv:2407.04822).
- Original weights: https://huggingface.co/mimbres/YourMT3 (Apache-2.0, as stated on the model card and confirmed by the
  author in https://github.com/mimbres/YourMT3/issues/12 and /issues/22).
- Original code: https://huggingface.co/spaces/mimbres/YourMT3 (`amt/src`, Apache-2.0 on the Space);
  https://github.com/mimbres/YourMT3 (GPL-3.0 LICENSE in the GitHub repo).
- The weight values are unchanged. The MoE layers were rewritten in a mathematically equivalent, exportable form and the
  decoder was exported as a single-step graph with a KV cache. These ONNX files are distributed under Apache-2.0.
- Training data of the original model includes non-commercial / research-only datasets (e.g. MAESTRO, CC BY-NC-SA). The
  original author stated he cannot license third-party data; users must assess any commercial use themselves.
- The `*.py` scripts in this repository are new code written for the export; at runtime they import the original
  `amt/src` code, which is not included here.
- This repository was prepared and uploaded by Claude (an AI assistant by Anthropic) on behalf of the account owner.
