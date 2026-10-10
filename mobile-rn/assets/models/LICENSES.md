# Runtime retrieval models

The Android package does not include these GGUF models. On first launch, OpenFicM downloads them from Hugging Face into the app-private document directory and verifies the recorded size and SHA-256 before use:

- `bge-small-en-v1.5-q4_k_m.gguf`
  - Source: `CompendiumLabs/bge-small-en-v1.5-gguf`
  - Base model: `BAAI/bge-small-en-v1.5`
  - License: MIT
  - Size: `24,808,576` bytes
  - SHA-256: `363a0a4855dff6c653e06efe3209157debcf7f74e52d0d7c71e2747cd523043e`
- `bge-reranker-base-q4_k_m.gguf`
  - Source: `sabafallah/bge-reranker-base-Q4_K_M-GGUF`
  - Base model: `BAAI/bge-reranker-base`
  - License: MIT
  - Size: `219,068,480` bytes
  - SHA-256: `18a10177d2494696616d252d55d42dc1046efe8b6b005aa911b5c167dc731f1c`
