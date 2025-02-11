// /api/setWebhook.js
export default async function handler(req, res) {
    const url = "https://registarasimgratis.vercel.app/telegram/webhook";
    const botToken = "7807378587:AAEA6tDXCUHWG7_MI13LtVE18QImQA9Yza8";
    const webhookUrl = `https://api.telegram.org/bot${botToken}/setWebhook`;
  
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          url: url, // URL webhook yang akan dipasang pada bot Telegram
        }),
      });
  
      const data = await response.json();
      
      if (data.ok) {
        return res.status(200).json({ message: 'Webhook set successfully!' });
      } else {
        return res.status(400).json({ message: 'Failed to set webhook.', data });
      }
    } catch (error) {
      return res.status(500).json({ message: 'Server Error', error: error.message });
    }
  }
  