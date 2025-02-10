### Instalasi curl

 **Windows:**
   - Unduh `curl` dari [situs resmi curl](https://curl.se/windows/).
   - Ekstrak file dan tambahkan direktori `curl` ke dalam `PATH` sistem.


### Cara Kerja Webhook dengan ngrok dan Telegram Bot API

1. **Menyiapkan ngrok:**
   - Unduh dan instal ngrok dari [situs resmi ngrok](https://ngrok.com/).
   - Jalankan ngrok dengan perintah: `ngrok http 3000` (gantilah `3000` dengan port yang digunakan oleh server lokal Anda).

2. **Mengatur Webhook Telegram:**
   - Gunakan `curl` untuk mengatur webhook Telegram dengan URL yang diberikan oleh ngrok.
   - Contoh perintah:
     ```bash
     curl -F "url=https://mayapadahospital.telegramapks.my.id/telegram/webhook" https://api.telegram.org/bot7807378587:AAEA6tDXCUHWG7_MI13LtVE18QImQA9Yza8/setWebhook
     ```
   - Gantilah `<ngrok-url>` dengan URL yang diberikan oleh ngrok dan `<tokenbot>` dengan token bot Telegram Anda.

3. **Menggunakan Webhook:**
   - Setiap kali ada pesan yang dikirim ke bot Telegram Anda, Telegram akan mengirimkan data ke URL webhook yang telah Anda atur.
   - Pastikan server Anda siap menerima dan memproses data yang dikirimkan oleh Telegram.

Dengan mengikuti langkah-langkah di atas, Anda dapat mengatur dan menggunakan webhook untuk berinteraksi dengan bot Telegram menggunakan ngrok dan curl.