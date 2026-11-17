import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

const img = process.argv[2];
const prompt = process.argv[3];

async function main() {
  const zai = await ZAI.create();
  const b64 = fs.readFileSync(img).toString('base64');
  const res = await zai.chat.completions.create({
    messages: [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: prompt },
      ]},
    ],
  });
  console.log(res.choices[0]?.message?.content ?? '(no content)');
}
main().catch(e => { console.error('VLM ERROR', e.message); process.exit(1); });
