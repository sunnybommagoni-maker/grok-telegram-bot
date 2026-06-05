require('dotenv').config();

const token = process.env.HF_ACCESS_TOKEN;
const model = 'black-forest-labs/FLUX.1-schnell';

async function test() {
  try {
    console.log(`Testing HF model: ${model}`);
    console.log(`Using token: ${token ? (token.substring(0, 8) + '...') : 'undefined'}`);
    
    const response = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ inputs: 'a cute kitten' }),
    });

    console.log('Status Code:', response.status);
    console.log('Status Text:', response.statusText);
    
    if (response.headers.get('content-type')?.includes('application/json')) {
      const json = await response.json();
      console.log('JSON Response:', JSON.stringify(json, null, 2));
    } else {
      const text = await response.text();
      console.log('Text Response (truncated):', text.substring(0, 500));
    }
  } catch (error) {
    console.error('Fetch error details:', error);
  }
}

test();
