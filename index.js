require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Groq } = require('groq-sdk');
const { HfInference } = require('@huggingface/inference');
const path = require('path');

// Initialize Express
const app = express();
app.use(express.json());

// Initialize API clients
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const hf = new HfInference(process.env.HF_ACCESS_TOKEN);

// Check if running on Hugging Face Spaces (SPACE_ID is set automatically by HF)
const IS_HF = !!process.env.SPACE_ID;
const PORT = process.env.PORT || 7860;

let bot;

if (IS_HF) {
  // Hugging Face Space URL structure: bommagoni-image.hf.space
  const subdomain = process.env.SPACE_ID.replace('/', '-').toLowerCase();
  const webhookUrl = `https://${subdomain}.hf.space/webhook`;
  
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`Telegram Webhook registered at: ${webhookUrl}`))
    .catch(err => console.error('Failed to set webhook:', err));
} else {
  // Local development: use polling
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('Telegram Bot started in polling mode (Local Development)');
}

// ----------------------------------------------------
// Prompt Enhancer (Groq Llama-3)
// ----------------------------------------------------
async function enhancePrompt(userPrompt) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are an elite prompt engineer for AI image generators (such as FLUX and Stable Diffusion). Your task is to rewrite the user\'s simple query into a descriptive, artistic, detailed, and visually stunning prompt in English. Include details about composition, lighting style, color palette, camera lens/settings, and artistic details. Keep it to 2-3 sentences. Output ONLY the enhanced prompt. Do not include any intro, outro, or quotes.'
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      model: 'llama3-8b-8192',
    });
    const enhanced = chatCompletion.choices[0]?.message?.content?.trim();
    return enhanced || userPrompt;
  } catch (error) {
    console.error('Groq prompt enhancement failed, using original prompt:', error);
    return userPrompt;
  }
}

// ----------------------------------------------------
// Image Generator (Hugging Face)
// ----------------------------------------------------
async function generateImage(prompt) {
  const models = [
    'black-forest-labs/FLUX.1-schnell',
    'stabilityai/stable-diffusion-xl-base-1.0'
  ];

  let lastError = null;

  for (const model of models) {
    try {
      console.log(`Sending prompt to HF model ${model}...`);
      const response = await hf.textToImage({
        model: model,
        inputs: prompt,
        parameters: {
          width: 1024,
          height: 1024,
        }
      });
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error(`HF model ${model} failed:`, error.message);
      lastError = error;
    }
  }

  throw new Error(`Hugging Face generation failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

// ----------------------------------------------------
// Bot Message Handlers
// ----------------------------------------------------
async function handleImageRequest(chatId, prompt) {
  // Send loading feedback
  const statusMsg = await bot.sendMessage(chatId, '🪄 *Step 1/2:* Groq is enhancing your prompt...', { parse_mode: 'Markdown' });

  try {
    // 1. Enhance using Groq
    const enhancedPrompt = await enhancePrompt(prompt);
    
    // Update status to image generation
    await bot.editMessageText(`✨ *Step 2/2:* Generating image using FLUX.1...\n\n_Enhanced prompt:_\n"${enhancedPrompt}"`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown'
    });

    // 2. Generate image using Hugging Face
    const imageBuffer = await generateImage(enhancedPrompt);

    // 3. Send image to user
    await bot.sendPhoto(chatId, imageBuffer, {
      caption: `🎨 *Here is your generated image!*\n\n_Original prompt:_\n"${prompt}"\n\n_Enhanced:_\n"${enhancedPrompt}"`,
      parse_mode: 'Markdown'
    });

    // Clean up loading message
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (error) {
    console.error('Image request handling failed:', error);
    await bot.editMessageText(`❌ *Failed to generate image.*\n\nError: ${error.message || 'An unknown error occurred.'}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown'
    }).catch(() => {
      bot.sendMessage(chatId, `❌ *Failed to generate image.*`);
    });
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `✨ *Welcome to AuraGen Bot!* ✨\n\nI am a premium image generator. You send a simple idea, I will use **Groq (Llama-3)** to enhance it, and **Hugging Face (FLUX.1)** to generate a stunning image!\n\n🚀 *How to use:*\nUse the command:\n\`/generate <your prompt>\`\n\nOr simply send me a direct message with your prompt!\n\nExample:\n\`/generate a golden retriever puppy in a spacesuit\`\n\nEnjoy creating!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `💡 *AuraGen Bot Commands*:\n\n• \`/generate <prompt>\` - Enhances and generates an image from your prompt.\n• \`/start\` or \`/help\` - Show bot info and welcome instructions.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/generate(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const prompt = match[1];

  if (!prompt) {
    bot.sendMessage(chatId, '⚠️ Please provide a prompt! Example: `/generate cute baby panda playing coding`', { parse_mode: 'Markdown' });
    return;
  }
  await handleImageRequest(chatId, prompt);
});

// Handle plain text messages in private chats (treating them directly as prompts)
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text) return;
  if (text.startsWith('/')) return; // Let command handlers process commands

  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';

  if (isPrivate) {
    await handleImageRequest(chatId, text);
  }
});

// ----------------------------------------------------
// Web Server (Express)
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Webhook endpoint for Telegram updates
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});
