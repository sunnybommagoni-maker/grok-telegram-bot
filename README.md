---
title: Image
emoji: 🎨
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# AuraGen Telegram Bot

A premium image generation Telegram bot powered by Hugging Face (FLUX) and Groq (Prompt Enhancer). Runs 24/7 on Hugging Face Spaces.

## Live Dashboard

You can visit the live status dashboard of the bot directly on the Hugging Face Space page:
[https://huggingface.co/spaces/Bommagoni/image](https://huggingface.co/spaces/Bommagoni/image)

## Features

- **24/7 Hosting**: Uses Express and Telegram Webhooks to run continuously.
- **Prompt Enhancer**: Uses Groq API with Llama-3 to automatically rewrite simple ideas into beautiful, artistic descriptions.
- **Top Image Models**: Uses Hugging Face API with `black-forest-labs/FLUX.1-schnell` (with `Stable Diffusion XL` as a fallback).
- **Glassmorphism Status Page**: A premium status page displayed directly in the Space.
