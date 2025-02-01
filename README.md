# 🚀 Speech Assistant OpenAI Realtime API Node

Welcome to **Speech Assistant OpenAI Realtime API Node** – the next-generation auto insurance claims assistant! 🤖📞

This project leverages OpenAI's realtime API using the cost-effective `gpt-4o-mini-realtime-preview-2024-12-17` model along with OpenAI Whisper for speech-to-text transcription. The assistant guides users through a friendly, decision-tree-based conversation to collect claim details, and logs a conversation transcript with **-- AGENT --** and **-- CUSTOMER --** labels.

## Features

- **Realtime TTS:** Uses OpenAI's realtime API for dynamic text-to-speech responses. 🎧✨
- **Speech-to-Text with Whisper:** Converts audio from Twilio using OpenAI Whisper. 🗣️➞🗒
- **Dynamic Decision Tree:** Collects essential claim details using a friendly conversation flow. 🛠️🗃
- **Transcript Logging:** Automatically saves conversation logs to `out.txt` with fancy labels. 📝💾
- **Modern Tech Stack:** Built with Fastify, WebSockets, and Node.js for a robust and scalable solution. 🚀

## Getting Started

### Prerequisites

- **Node.js** (v16 or higher recommended)
- **ffmpeg** (Installed via [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) – no extra setup needed)
- An [OpenAI API key](https://platform.openai.com/)

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/yourusername/speech-assistant-openai-realtime-api-node.git
   cd speech-assistant-openai-realtime-api-node
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Create a `.env` file** in the root directory and add your OpenAI API key:

   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   ```

### Running the Application

Start the server with:

```bash
npm start
```

The server will listen on port **5050**. When a call is initiated via Twilio, the assistant will begin interacting with the customer using realtime audio and speech transcription.

## Usage

- **Incoming Call:**  
  Twilio connects to your `/incoming-call` endpoint, which returns a TWiML response to stream audio to your Node.js server.
  
- **Realtime Interaction:**  
  The assistant greets the customer, processes their audio input with Whisper, and uses the decision tree logic to collect claim information.
  
- **Transcript Logging:**  
  All interactions are logged in `out.txt` with clear **-- AGENT --** and **-- CUSTOMER --** annotations.

## Contributing

Feel free to fork this repository and submit pull requests. For major changes, please open an issue first to discuss what you would like to change. 😎👍

## License

This project is licensed under the ISC License. See the [LICENSE](LICENSE) file for details.

---

Happy coding! 🚀🤖✨

