# Smart Converter MCP - WhatsApp File Conversion Bot

Smart Converter MCP is a WhatsApp bot powered by Twilio that allows users to upload files via WhatsApp, convert them to different formats, and receive the converted file back directly in the chat. The bot supports multiple file formats and uses free file hosting services to deliver the converted files through WhatsApp.

---

## Features

- Upload files directly on WhatsApp to the bot
- Detects file types by reading file content
- Offers conversion options excluding the original file format
- Converts files between formats (dummy copy-based conversion included; extensible for real conversion)
- Uploads converted files to Filebin.net (free anonymous file hosting) and shares public URL
- Sends converted files back to users via WhatsApp media messages
- Graceful error handling and user-friendly prompts
- Session management for multi-step workflows with timeout and resource cleanup

---

## Supported Formats

- PDF
- PNG
- JPG / JPEG
- Word Documents (DOC/DOCX)
- CSV
- TXT

---

## Prerequisites

- Node.js (v14+ recommended)
- Twilio account with WhatsApp sandbox enabled
- Twilio Account SID and Auth Token
- Internet-accessible server to host your bot (or use tools like ngrok for local dev)

---

## Installation

1. Clone this repository:

git clone https://github.com/yourusername/smart-converter-mcp.git
cd smart-converter-mcp


2. Install dependencies:


3. Update Twilio credentials in `creds.env`:

TWILIO_ACCOUNT_SID=your-twilio-sid-here
TWILIO_AUTH_TOKEN=your-auth-token-here


4. Start the server:

node server.js


---

## Usage

1. Configure your WhatsApp sandbox webhook in the Twilio Console to point to your server’s `/whatsapp_webhook` endpoint.

2. Send a supported file (PDF, PNG, JPG, Word, CSV, TXT) to your WhatsApp sandbox number.

3. The bot will respond asking which format you want to convert your file to (excluding the original file format).

4. Reply with your desired conversion format as a name (e.g., `pdf`) or option number.

5. The bot converts the file (currently a dummy copy operation), uploads it to Filebin.net, and sends you the converted file back via WhatsApp.

---

## Notes & Limitations

- The current file conversion logic is a placeholder – it copies the file with a new extension. Real conversion logic can be added as needed.
- Files are uploaded temporarily to Filebin.net (free hosting with retention of about 7 days).
- File upload size is limited to 10MB.
- Sessions timeout after 10 minutes of inactivity.
- The bot uses Twilio’s WhatsApp sandbox for messaging, which has limitations (e.g., limited number of recipients).

---

## Folder Structure

- `index.js` — Main Node.js server and WhatsApp bot logic.
- `package.json` — Node.js dependencies.
- `.gitignore` — Ignore `node_modules`, logs, and temp files.

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

## License

This project is licensed under the MIT License.

---

## Contact

For questions or support, reach out to [your-email@example.com].

---

*Built with ❤️ using Node.js, Twilio WhatsApp API, and Filebin.net.*


