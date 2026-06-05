require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const { Groq } = require('groq-sdk');
const path = require('path');
const https = require('https');

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
const TELEGRAM_API_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

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
async function generateImage(prompt) {
  const models = [
    'black-forest-labs/FLUX.1-schnell',
    'stabilityai/stable-diffusion-xl-base-1.0'
  ];

  let lastError = null;

  for (const model of models) {
    try {
      console.log(`Sending prompt to HF model ${model} via native HTTPS...`);
      const url = `https://api-inference.huggingface.co/models/${model}`;
      
      const response = await httpsRequest(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.HF_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }, { inputs: prompt });
      
      if (response.ok) {
        return response.buffer;
      }
      
      const errorText = response.buffer.toString('utf8');
      console.error(`HF model ${model} failed with status ${response.status}:`, errorText);
      lastError = new Error(`Status ${response.status}: ${errorText}`);
    } catch (error) {
      console.error(`HF model ${model} request error:`, error.message);
      lastError = error;
    }
  }

  throw new Error(`Hugging Face generation failed: ${lastError ? lastError.message : 'Unknown error'}`);
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

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  
  if (text.startsWith('/start')) {
    await sendTelegramMessage(chatId, `✨ *Welcome to AuraGen Bot!* ✨\n\nI am a premium image generator. You send a simple idea, I will use **Groq (Llama-3)** to enhance it, and **Hugging Face (FLUX.1)** to generate a stunning image!\n\n🚀 *How to use:*\nUse the command:\n\`/generate <your prompt>\`\n\nOr simply send me a direct message with your prompt!\n\nExample:\n\`/generate a golden retriever puppy in a spacesuit\`\n\nEnjoy creating!`, { parse_mode: 'Markdown' });
  } else if (text.startsWith('/help')) {
    await sendTelegramMessage(chatId, `💡 *AuraGen Bot Commands*:\n\n• \`/generate <prompt>\` - Enhances and generates an image from your prompt.\n• \`/start\` or \`/help\` - Show bot info and welcome instructions.`, { parse_mode: 'Markdown' });
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

// Diagnostic endpoint to test Hugging Face connection inside Space
app.get('/test-hf', async (req, res) => {
  try {
    const token = process.env.HF_ACCESS_TOKEN;
    const model = 'black-forest-labs/FLUX.1-schnell';
    
    console.log(`Running diagnostic fetch for: ${model}`);
    const response = await httpsRequest(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      }
    }, { inputs: 'a cute kitten' });

    res.json({
      status: response.status,
      headers: response.headers,
      body: response.ok ? 'Image Buffer Received successfully' : response.buffer.toString('utf8')
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Webhook endpoint for Telegram updates
app.post('/webhook', (req, res) => {
  handleUpdate(req.body).catch(err => console.error('Error handling webhook update:', err));
  res.sendStatus(200);
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
  
  // Set Webhook or Polling based on environment
  const useWebhook = IS_HF || !!process.env.BOT_URL || !!process.env.RENDER_EXTERNAL_URL;
  
  if (useWebhook) {
    const baseUrl = process.env.BOT_URL || process.env.RENDER_EXTERNAL_URL || `https://${process.env.SPACE_ID.replace('/', '-').toLowerCase()}.hf.space`;
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
  } else {
    // Long Polling loop for local testing
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
  }
});
