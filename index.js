require('dotenv').config();

// In-memory logger for remote diagnostics
const logs = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  logs.push(`[LOG] ${new Date().toISOString()}: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`);
  if (logs.length > 200) logs.shift();
  originalLog.apply(console, args);
};

console.error = (...args) => {
  logs.push(`[ERROR] ${new Date().toISOString()}: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`);
  if (logs.length > 200) logs.shift();
  originalError.apply(console, args);
};
const express = require('express');
const { Groq } = require('groq-sdk');
const path = require('path');
const https = require('https');
const { Client } = require('@gradio/client');

// Initialize Express
const app = express();
app.use(express.json());

// Initialize Groq API client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Check environment
const IS_HF = !!process.env.SPACE_ID;
const PORT = process.env.PORT || 7860;

// ----------------------------------------------------
// Native HTTPS Request Helper
// ----------------------------------------------------
function httpsRequest(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 60000 // 60 seconds timeout
    };

    const req = https.request(requestOptions, (res) => {
      let data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          buffer: buffer,
          text: () => Promise.resolve(buffer.toString('utf8')),
          json: () => Promise.resolve(JSON.parse(buffer.toString('utf8')))
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timeout'));
    });

    if (postData) {
      if (postData instanceof Buffer) {
        req.write(postData);
      } else if (typeof postData === 'object') {
        req.write(JSON.stringify(postData));
      } else {
        req.write(postData);
      }
    }
    
    req.end();
  });
}

// ----------------------------------------------------
// Telegram API Helper Functions (Native HTTPS)
// ----------------------------------------------------
const TELEGRAM_API_URL = `${process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'}/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    const response = await httpsRequest(`${TELEGRAM_API_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      chat_id: chatId,
      text: text,
      ...options
    });
    return await response.json();
  } catch (err) {
    console.error('Error sending message:', err.message);
    throw err;
  }
}

async function editTelegramMessage(chatId, messageId, text, options = {}) {
  try {
    const response = await httpsRequest(`${TELEGRAM_API_URL}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      ...options
    });
    return await response.json();
  } catch (err) {
    console.error('Error editing message:', err.message);
    throw err;
  }
}

async function deleteTelegramMessage(chatId, messageId) {
  try {
    await httpsRequest(`${TELEGRAM_API_URL}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (err) {
    console.error('Error deleting message:', err.message);
  }
}

async function sendTelegramPhoto(chatId, imageBuffer, caption, options = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    let parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    if (options.parse_mode) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${options.parse_mode}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
    
    const postData = Buffer.concat([
      ...parts,
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    
    const parsedUrl = new URL(`${TELEGRAM_API_URL}/sendPhoto`);
    const requestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': postData.length
      },
      timeout: 60000
    };
    
    const req = https.request(requestOptions, (res) => {
      let data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        resolve(JSON.parse(Buffer.concat(data).toString('utf8')));
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SendPhoto connection timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

// ----------------------------------------------------
// Prompt Enhancer (Groq Llama-3.1)
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
      model: 'llama-3.1-8b-instant',
    });
    const enhanced = chatCompletion.choices[0]?.message?.content?.trim();
    return enhanced || userPrompt;
  } catch (error) {
    console.error('Groq prompt enhancement failed, using original prompt:', error);
    return userPrompt;
  }
}

// ----------------------------------------------------
// Image Generator (Hugging Face API via Native HTTPS)
// ----------------------------------------------------
// ----------------------------------------------------
// Image Generator (OpenRouter / Hugging Face API)
// ----------------------------------------------------
async function generateImage(prompt) {
  // 1. Try Hugging Face Inference API via new router URL (using token, bypasses IP limits)
  if (process.env.HF_ACCESS_TOKEN) {
    try {
      console.log('Generating image using Hugging Face (FLUX.1-schnell via router)...');
      const model = 'black-forest-labs/FLUX.1-schnell';
      const url = `https://router.huggingface.co/hf-inference/models/${model}`;
      const response = await httpsRequest(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.HF_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, { inputs: prompt });

      if (response.ok) {
        console.log('Hugging Face image generation successful!');
        return response.buffer;
      }
      console.error(`Hugging Face Inference returned status ${response.status}:`, response.buffer.toString('utf8'));
    } catch (error) {
      console.error('Hugging Face Inference failed:', error.message);
    }
  }

  // 2. Fallback to Pollinations AI (FLUX, free & unrestricted)
  try {
    console.log('Generating image using Pollinations AI (FLUX)...');
    const encodedPrompt = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&private=true&model=flux`;
    
    const response = await httpsRequest(url);
    if (response.ok) {
      console.log('Pollinations AI image generation successful!');
      return response.buffer;
    }
    throw new Error(`Status ${response.status}`);
  } catch (error) {
    console.error('Pollinations AI image generation failed:', error.message);
    
    // 3. Fallback to OpenRouter (paid, grok-imagine)
    if (process.env.OPENROUTER_API_KEY) {
      try {
        console.log('Falling back to OpenRouter (x-ai/grok-imagine)...');
        const response = await httpsRequest('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://huggingface.co/spaces/Bommagoni/image',
            'X-Title': 'AuraGen Bot'
          }
        }, {
          model: 'x-ai/grok-imagine-image-quality',
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          modalities: ['image']
        });

        const data = await response.json();
        const base64Url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
        if (base64Url) {
          const base64Data = base64Url.split(',')[1];
          console.log('OpenRouter image generation successful!');
          return Buffer.from(base64Data, 'base64');
        } else {
          const errorMsg = data.error?.message || 'OpenRouter response did not contain image url';
          console.error('OpenRouter response did not contain image url:', JSON.stringify(data));
          throw new Error(errorMsg);
        }
      } catch (orError) {
        console.error('OpenRouter fallback image generation failed:', orError.message);
      }
    }
    throw new Error(`Image generation failed: ${error.message}`);
  }
}

// ----------------------------------------------------
// Bot Message Handlers & Router
// ----------------------------------------------------
async function handleImageRequest(chatId, prompt) {
  const statusMsgResult = await sendTelegramMessage(chatId, '🪄 *Step 1/2:* Groq is enhancing your prompt...', { parse_mode: 'Markdown' });
  const statusMsgId = statusMsgResult.result?.message_id;

  try {
    const enhancedPrompt = await enhancePrompt(prompt);
    
    if (statusMsgId) {
      await editTelegramMessage(chatId, statusMsgId, `✨ *Step 2/2:* Generating image using FLUX.1...\n\n_Enhanced prompt:_\n"${enhancedPrompt}"`, {
        parse_mode: 'Markdown'
      });
    }

    const imageBuffer = await generateImage(enhancedPrompt);

    await sendTelegramPhoto(chatId, imageBuffer, `🎨 *Here is your generated image!*\n\n_Original prompt:_\n"${prompt}"\n\n_Enhanced:_\n"${enhancedPrompt}"`, {
      parse_mode: 'Markdown'
    });

    if (statusMsgId) {
      await deleteTelegramMessage(chatId, statusMsgId).catch(() => {});
    }
  } catch (error) {
    console.error('Image request handling failed:', error);
    if (statusMsgId) {
      await editTelegramMessage(chatId, statusMsgId, `❌ *Failed to generate image.*\n\nError: ${error.message || 'An unknown error occurred.'}`, {
        parse_mode: 'Markdown'
      }).catch(() => {
        sendTelegramMessage(chatId, `❌ *Failed to generate image.*`);
      });
    } else {
      await sendTelegramMessage(chatId, `❌ *Failed to generate image.*`);
    }
  }
}

// ----------------------------------------------------
// Image Download & Analysis for Photo Editing
// ----------------------------------------------------
async function downloadTelegramFile(fileId) {
  try {
    const getFileUrl = `${TELEGRAM_API_URL}/getFile?file_id=${fileId}`;
    const response = await httpsRequest(getFileUrl);
    const fileData = await response.json();
    if (!fileData.ok) {
      throw new Error(`Telegram getFile failed: ${JSON.stringify(fileData)}`);
    }
    const filePath = fileData.result.file_path;
    const downloadUrl = `${process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const fileResponse = await httpsRequest(downloadUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file from Telegram: status ${fileResponse.status}`);
    }
    return fileResponse.buffer;
  } catch (err) {
    console.error('Error downloading Telegram file:', err.message);
    throw err;
  }
}

async function editImage(imageBuffer, instruction) {
  try {
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
    const app = await Client.connect('timbrooks/instruct-pix2pix');
    
    // API signature: [image, prompt, steps, seed_strategy, seed, cfg_strategy, text_cfg, image_cfg]
    const result = await app.predict('/generate', [
      blob,                                  // Input Image
      instruction || 'Enhance this image',   // Edit Instruction
      20,                                    // Steps
      'Randomize Seed',                      // Seed strategy
      0,                                     // Seed (ignored)
      'Fix CFG',                             // CFG strategy
      7.5,                                   // Text CFG
      1.5                                    // Image CFG
    ]);

    // Gradio returns a data array. For this space, data[3] is the output image object.
    const outputData = result.data[3];
    if (outputData && outputData.url) {
      // Download the generated image from the Gradio URL
      const response = await fetch(outputData.url);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      throw new Error('Gradio result did not contain an image URL');
    }
  } catch (error) {
    console.error('Gradio Instruct-Pix2Pix failed:', error);
    throw new Error('Image editing failed. The editor might be asleep or overloaded. Try again in a minute!');
  }
}

async function handlePhotoRequest(chatId, photo, caption) {
  const statusMsgResult = await sendTelegramMessage(chatId, '⚙️ *Step 1/2:* Connecting to the Image Editor...\n_(Note: If the editor was asleep, this may take 1-3 minutes to wake up)_', { parse_mode: 'Markdown' });
  const statusMsgId = statusMsgResult.result?.message_id;

  try {
    const fileId = photo[photo.length - 1].file_id;
    const imageBuffer = await downloadTelegramFile(fileId);

    if (statusMsgId) {
      await editTelegramMessage(chatId, statusMsgId, `✨ *Step 2/2:* Generating edited image using Instruct-Pix2Pix...\n\n_Instruction:_\n"${caption || 'Enhance image'}"`, {
        parse_mode: 'Markdown'
      });
    }

    const editedImageBuffer = await editImage(imageBuffer, caption);

    await sendTelegramPhoto(chatId, editedImageBuffer, `🎨 *Here is your edited image!*\n\n_Instruction used:_\n"${caption || 'Enhance image'}"`, {
      parse_mode: 'Markdown'
    });

    if (statusMsgId) {
      await deleteTelegramMessage(chatId, statusMsgId).catch(() => {});
    }
  } catch (error) {
    console.error('Photo request handling failed:', error);
    if (statusMsgId) {
      await editTelegramMessage(chatId, statusMsgId, `❌ *Failed to edit image.*\n\nError: ${error.message || 'An unknown error occurred.'}`, {
        parse_mode: 'Markdown'
      }).catch(() => {
        sendTelegramMessage(chatId, `❌ *Failed to edit image.*`);
      });
    } else {
      await sendTelegramMessage(chatId, `❌ *Failed to edit image.*`);
    }
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  
  const chatId = msg.chat.id;

  // Handle uploaded photo
  if (msg.photo && msg.photo.length > 0) {
    await handlePhotoRequest(chatId, msg.photo, msg.caption);
    return;
  }

  if (!msg.text) return;
  const text = msg.text.trim();
  
  if (text.startsWith('/start')) {
    await sendTelegramMessage(chatId, `✨ *Welcome to AuraGen Bot!* ✨\n\nI am a premium image generator. You send a simple idea, I will use **Groq (Llama-3)** to enhance it, and **FLUX.1 (unrestricted)** to generate a stunning image!\n\n🚀 *How to use:*\nUse the command:\n\`/generate <your prompt>\`\n\nOr simply send me a direct message with your prompt!\n\nExample:\n\`/generate a golden retriever puppy in a spacesuit\`\n\n🖼️ *Image Editing:*\nYou can also upload any image and describe how you want to modify it in the caption! I will use **Llama-4 Vision** to understand it and generate the edited version for you!\n\nEnjoy creating!`, { parse_mode: 'Markdown' });
  } else if (text.startsWith('/help')) {
    await sendTelegramMessage(chatId, `💡 *AuraGen Bot Commands*:\n\n• \`/generate <prompt>\` - Enhances and generates an image from your prompt.\n• \`/start\` or \`/help\` - Show bot info and welcome instructions.\n• *Image Editing* - Just upload a photo and write the changes you want in the caption!`, { parse_mode: 'Markdown' });
  } else if (text.startsWith('/generate')) {
    const prompt = text.replace(/^\/generate\s*/, '');
    if (!prompt) {
      await sendTelegramMessage(chatId, '⚠️ Please provide a prompt! Example: `/generate cute baby panda playing coding`', { parse_mode: 'Markdown' });
      return;
    }
    await handleImageRequest(chatId, prompt);
  } else {
    // Direct private message handles directly
    const isPrivate = msg.chat.type === 'private';
    if (isPrivate) {
      await handleImageRequest(chatId, text);
    }
  }
}

// ----------------------------------------------------
// Web Server (Express) & Webhook/Polling Init
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Diagnostic endpoint to test Pollinations AI connection
app.get('/test-pollinations', async (req, res) => {
  try {
    console.log('Running diagnostic Pollinations fetch...');
    const response = await httpsRequest('https://image.pollinations.ai/prompt/a%20cute%20kitten?width=512&height=512&nologo=true&private=true&model=flux');

    res.json({
      status: response.status,
      headers: response.headers,
      ok: response.ok,
      body: response.ok ? 'Image Buffer Received successfully' : response.buffer.toString('utf8')
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Diagnostic endpoint to test OpenRouter connection
app.get('/test-openrouter', async (req, res) => {
  try {
    const token = process.env.OPENROUTER_API_KEY;
    const model = 'x-ai/grok-imagine-image-quality';
    
    console.log(`Running diagnostic OpenRouter fetch for: ${model}`);
    const response = await httpsRequest('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      model: model,
      messages: [{ role: 'user', content: 'a cute kitten' }],
      modalities: ['image']
    });

    const data = await response.json();
    res.json({
      status: response.status,
      headers: response.headers,
      body: data
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Remote log viewer endpoint
app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(logs.join('\n'));
});

// Webhook endpoint for Telegram updates
app.post('/webhook', (req, res) => {
  handleUpdate(req.body).catch(err => console.error('Error handling webhook update:', err));
  res.sendStatus(200);
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
  
  // Set Webhook or Polling based on environment. Disable bot logic on Hugging Face to avoid webhook hijacking.
  const useWebhook = !IS_HF && (!!process.env.BOT_URL || !!process.env.RENDER_EXTERNAL_URL);
  
  if (useWebhook) {
    const baseUrl = process.env.BOT_URL || process.env.RENDER_EXTERNAL_URL;
    const webhookUrl = `${baseUrl}/webhook`;
    
    const setWebhookWithRetry = async (retries = 5, delay = 5000) => {
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`Attempting to set webhook to: ${webhookUrl} (attempt ${i + 1}/${retries})...`);
          const setUrl = `${TELEGRAM_API_URL}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
          const response = await httpsRequest(setUrl);
          const result = await response.json();
          if (result.ok) {
            console.log('Telegram Webhook registered successfully!');
            return;
          }
          console.error('Failed to set webhook:', result);
        } catch (err) {
          console.error(`Failed to set webhook error:`, err.message);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      console.error('All webhook registration attempts failed.');
    };
    
    setWebhookWithRetry();
  } else if (!IS_HF) {
    // Long Polling loop for local testing (skip on HF)
    const startPolling = async () => {
      console.log('Starting local long polling loop...');
      let offset = 0;
      while (true) {
        try {
          const response = await httpsRequest(`${TELEGRAM_API_URL}/getUpdates?offset=${offset}&timeout=30`);
          const data = await response.json();
          if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
              offset = update.update_id + 1;
              const updateResult = await handleUpdate(update);
            }
          }
        } catch (err) {
          console.error('Polling error:', err.message);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    };
    
    startPolling();
  } else {
    console.log('Running on Hugging Face Space: Telegram Bot logic is DISABLED to prevent webhook hijacking. Webhook is managed by Render.');
  }
});
