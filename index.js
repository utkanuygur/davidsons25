import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { Configuration, OpenAIApi } from 'openai';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

// === OpenAI Setup (for Whisper and GPT Realtime) ===
const openAiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openai = new OpenAIApi(openAiConfig);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

//
// === CONFIGURATION CONSTANTS ===
//
const SYSTEM_MESSAGE = `
You are a helpful and friendly AI assistant specialized in gathering information for auto insurance claims. 
You follow a decision tree approach to collect essential claim information. 
You love to provide subtle dad jokes, owl jokes, or an occasional rickroll reference - all in a nice, positive style. 
Always confirm the user’s statements politely and then ask the next required question.
`;
const VOICE = 'alloy';
const PORT = 5050; 
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created'
];

const SHOW_TIMING_MATH = false;

// A simple in-memory store for conversation data.
const conversationStates = {};

// Decision tree questions
const mainFlow = [
  { name: 'policyId', question: 'First, can you please tell me your policy ID?' },
  { name: 'claimType', question: 'Great, now please describe the nature of your claim, for example: Car accident, theft, or vandalism?' },
];

// Subflows
const carAccidentFlow = [
  { name: 'alcoholInvolvement', question: 'Was there any alcohol involved from either side? Yes or No?' },
  { name: 'accidentSeverity', question: 'How severe was the accident? (e.g., minor fender-bender, moderate, total loss?)' },
  { name: 'accidentInjuries', question: 'Were there any injuries? Please describe briefly.' },
  { name: 'accidentComplete', question: 'Thank you. Anything else to add regarding this accident?' }
];

const theftFlow = [
  { name: 'theftLocation', question: 'Where did the theft occur? (Example: parking lot, street, at home, etc.)' },
  { name: 'theftItemsStolen', question: 'What items or parts were stolen from the vehicle?' },
  { name: 'theftPoliceReport', question: 'Have you filed a police report? If yes, do you have a report number?' },
  { name: 'theftComplete', question: 'Alright, thanks. Anything else about this theft incident?' }
];

const vandalismFlow = [
  { name: 'vandalismDetails', question: 'Can you describe the vandalism? e.g. broken windows, spray paint, etc.?' },
  { name: 'vandalismPoliceReport', question: 'Did you report the vandalism to authorities? If so, reference?' },
  { name: 'vandalismComplete', question: 'Understood. Anything else regarding the vandalism incident?' }
];

/**
 * Finalizes the claim after the user finishes all required questions.
 */
function finalizeClaim(connection, openAiWs, streamSid) {
  const { conversationData } = conversationStates[streamSid] || { conversationData: {} };
  
  let summary = `Here is the summary of your claim:\n`;
  Object.keys(conversationData).forEach(key => {
    summary += `- ${key}: ${conversationData[key]}\n`;
  });
  summary += 'Thank you for all the information! We will now store these details. Have a wonderful day!';

  logToTranscriptFile(`\n-- AGENT --\n${summary}\n`);
  sendAssistantMessage(openAiWs, summary);
}

/**
 * Picks the next question based on the conversation state.
 */
function askNextQuestion(connection, openAiWs, streamSid) {
  const state = conversationStates[streamSid];
  if (!state) return;

  const { decisionTreeStep, subFlowStep, subFlow } = state;
  
  // Still in main flow
  if (decisionTreeStep < mainFlow.length) {
    const nextQuestion = mainFlow[decisionTreeStep].question;
    logToTranscriptFile(`\n-- AGENT --\n${nextQuestion}\n`);
    sendAssistantMessage(openAiWs, nextQuestion);
    return;
  }
  
  // Main flow done; check subFlow
  if (!subFlow) {
    const fallback = 'Thanks for that. We have minimal details on your claim. Anything else? Or say "done".';
    logToTranscriptFile(`\n-- AGENT --\n${fallback}\n`);
    sendAssistantMessage(openAiWs, fallback);
    return;
  }
  
  const subFlowQuestions = subFlow.flowArray;
  if (subFlowStep < subFlowQuestions.length) {
    const nextQuestion = subFlowQuestions[subFlowStep].question;
    logToTranscriptFile(`\n-- AGENT --\n${nextQuestion}\n`);
    sendAssistantMessage(openAiWs, nextQuestion);
  } else {
    finalizeClaim(connection, openAiWs, streamSid);
  }
}

/**
 * Processes the recognized user text from Whisper to fill the decision tree.
 */
function handleUserResponse(connection, openAiWs, streamSid, userText) {
  const state = conversationStates[streamSid];
  if (!state) return;
  
  let { decisionTreeStep, subFlow, subFlowStep, conversationData } = state;
  
  // If in main flow
  if (decisionTreeStep < mainFlow.length) {
    const questionObj = mainFlow[decisionTreeStep];
    conversationData[questionObj.name] = userText;
    
    // On claimType, pick subFlow
    if (questionObj.name === 'claimType') {
      const claimType = userText.toLowerCase();
      if (claimType.includes('car')) {
        subFlow = { name: 'carAccidentFlow', flowArray: carAccidentFlow };
      } else if (claimType.includes('theft')) {
        subFlow = { name: 'theftFlow', flowArray: theftFlow };
      } else if (claimType.includes('vandalism')) {
        subFlow = { name: 'vandalismFlow', flowArray: vandalismFlow };
      } else {
        subFlow = null;
      }
      state.subFlow = subFlow;
    }
    
    // Move to next question in the main flow
    state.decisionTreeStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
    return;
  }
  
  // Main flow is done but no subFlow
  if (!subFlow) {
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      const msg = 'Noted. Anything else you want to add? Or say "done" to finalize.';
      logToTranscriptFile(`\n-- AGENT --\n${msg}\n`);
      sendAssistantMessage(openAiWs, msg);
    }
    return;
  }
  
  // We are in a subFlow
  const subFlowQuestions = subFlow.flowArray;
  if (subFlowStep < subFlowQuestions.length) {
    const questionObj = subFlowQuestions[subFlowStep];
    conversationData[questionObj.name] = userText;
    state.subFlowStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
  } else {
    // Possibly user is still talking after subFlow done
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      const doneMsg = 'I believe I have all details. Please say "done" or add final comments.';
      logToTranscriptFile(`\n-- AGENT --\n${doneMsg}\n`);
      sendAssistantMessage(openAiWs, doneMsg);
    }
  }
}

/**
 * Sends a message from the assistant to the user (for TTS).
 */
function sendAssistantMessage(openAiWs, text) {
  const conversationItem = {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'input_text', text }
      ]
    }
  };
  openAiWs.send(JSON.stringify(conversationItem));
  // Trigger TTS
  openAiWs.send(JSON.stringify({ type: 'response.create' }));
}

/**
 * Logs lines to out.txt in the form:
 *   -- AGENT --
 *   Some text
 * or
 *   -- CUSTOMER --
 *   Some text
 */
function logToTranscriptFile(text) {
  fs.appendFileSync('out.txt', text, 'utf8');
}

/**
 * Sends a greeting after we have a valid streamSid and openAiWs session.
 */
function sendGreeting(openAiWs) {
  const greeting = `Hello there! I am your AI voice assistant for auto insurance claims. Let’s get started!`;
  logToTranscriptFile(`\n-- AGENT --\n${greeting}\n`);
  sendAssistantMessage(openAiWs, greeting);
}

//
// =============== SERVER SETUP ===============
//
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Twilio inbound calls: TWiML response.
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Please wait while we connect your call</Say>
      <Pause length="1"/>
      <Say>O.K. you can start talking!</Say>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream.
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // We accumulate raw G.711 data while the user is speaking.
    let userAudioChunks = [];

    // Create a WebSocket to connect to OpenAI Realtime (TTS)
    // Note: Using the cheaper model endpoint here.
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    /**
     * Initialize the GPT Realtime session (for TTS).
     */
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
        }
      };
      console.log('Sending session update:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    //
    // ============= OPENAI WS (Realtime TTS) HANDLERS =============
    //
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(() => {
        initializeSession();
      }, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // Forward TTS audio deltas to Twilio.
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }
          sendMark(connection, streamSid);
        }

        // If user speech starts while agent is talking, handle potential barge-in logic.
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('Error processing OpenAI Realtime message:', error, 'Raw message:', data);
      }
    });

    openAiWs.on('close', () => {
      console.log('Disconnected from the OpenAI Realtime API');
    });

    openAiWs.on('error', (error) => {
      console.error('Error in the OpenAI Realtime WebSocket:', error);
    });

    //
    // ============= TWILIO WS HANDLERS =============
    //
    connection.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream has started', streamSid);

            // Initialize conversation state for this call.
            conversationStates[streamSid] = {
              decisionTreeStep: 0,
              subFlow: null,
              subFlowStep: 0,
              conversationData: {}
            };

            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;

            // Once we have a valid streamSid, greet the user (TTS).
            if (openAiWs.readyState === WebSocket.OPEN) {
              sendGreeting(openAiWs);
            }
            break;

          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            // Accumulate raw G.711 data if the user is speaking.
            if (userIsSpeaking) {
              const chunk = Buffer.from(data.media.payload, 'base64');
              userAudioChunks.push(chunk);
            }

            // Also feed the audio to GPT Realtime (for TTS).
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;

          case 'mark':
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;

          case 'stop':
            // Occurs at call hangup.
            break;

          default:
            console.log('Received non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('Error parsing message:', error, 'Message:', message);
      }
    });

    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      if (streamSid && conversationStates[streamSid]) {
        delete conversationStates[streamSid];
      }
      console.log('Client disconnected.');
    });

    //
    // ============= HELPER LOGIC (SPEECH START/STOP, WHISPER, ETC.) =============
    //

    // We'll track whether the user is speaking.
    let userIsSpeaking = false;

    /**
     * Called when speech starts.
     */
    function handleSpeechStartedEvent() {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }
        connection.send(JSON.stringify({ event: 'clear', streamSid }));
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
      // Begin capturing user audio.
      userIsSpeaking = true;
      userAudioChunks = [];
    }

    /**
     * Called when the user finishes speaking.
     * 1) Write raw µ-law data to a temp file.
     * 2) Convert the raw file to WAV using ffmpeg.
     * 3) Send the WAV file to Whisper.
     * 4) Log transcript as -- CUSTOMER --.
     * 5) Pass transcript text to decision-tree logic.
     */
    async function handleSpeechStoppedEvent() {
      userIsSpeaking = false;
      if (userAudioChunks.length === 0) return;

      // Write raw G.711 data to a temporary file.
      const rawFile = `temp_ulaw_${Date.now()}.raw`;
      fs.writeFileSync(rawFile, Buffer.concat(userAudioChunks));

      // Convert .raw to .wav using ffmpeg.
      const wavFile = `temp_wav_${Date.now()}.wav`;
      await convertUlawToWav(rawFile, wavFile);

      // Send the WAV file to OpenAI Whisper.
      let transcriptText = '';
      try {
        const resp = await openai.createTranscription(
          fs.createReadStream(wavFile),
          'whisper-1'
        );
        transcriptText = resp.data.text.trim();
      } catch (err) {
        console.error('Error calling Whisper API:', err);
      }

      // Clean up temporary files.
      fs.unlinkSync(rawFile);
      fs.unlinkSync(wavFile);

      if (!transcriptText) return;

      // Log the user's text.
      logToTranscriptFile(`\n-- CUSTOMER --\n${transcriptText}\n`);

      // Pass the transcript to the decision-tree logic.
      handleUserResponse(connection, openAiWs, streamSid, transcriptText);
    }

    // Use a simple inactivity timer to detect speech stop.
    let silenceTimer = null;
    const SILENCE_TIMEOUT_MS = 3000;
    setInterval(async () => {
      const now = Date.now();
      if (userIsSpeaking && (now - latestMediaTimestamp > SILENCE_TIMEOUT_MS)) {
        await handleSpeechStoppedEvent();
      }
    }, 1000);

    /**
     * Converts raw 8kHz µ-law data to a linear PCM WAV file using ffmpeg.
     */
    async function convertUlawToWav(rawPath, wavPath) {
      return new Promise((resolve, reject) => {
        // Example ffmpeg command:
        // ffmpeg -f mulaw -ar 8000 -i input.raw -ar 16000 -ac 1 output.wav
        const args = [
          '-f', 'mulaw',
          '-ar', '8000',
          '-i', rawPath,
          '-ar', '16000',
          '-ac', '1',
          wavPath
        ];
        const ff = spawn(ffmpegPath, args);

        ff.on('error', (err) => {
          console.error('Failed to start ffmpeg:', err);
          reject(err);
        });

        ff.on('close', (code) => {
          if (code === 0) {
            resolve(true);
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });
      });
    }

    function sendMark(connection, streamSid) {
      if (streamSid) {
        const markEvent = {
          event: 'mark',
          streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    }

    // Optionally listen for GPT Realtime's 'input_audio_buffer.speech_stopped'
    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        if (response.type === 'input_audio_buffer.speech_stopped') {
          await handleSpeechStoppedEvent();
        }
      } catch {}
    });

  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
