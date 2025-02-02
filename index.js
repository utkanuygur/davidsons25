/*****************************************************
 * server.js
 * 
 * A streamlined Fastify-based server integrating
 * Twilio Media Streams with OpenAI Realtime.
 *****************************************************/

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs'

// Load environment variables, including OPENAI_API_KEY
fs.truncateSync('transcript.txt', 0);

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = 5050;
const VOICE = 'alloy';

/** 
 * System instructions for the OpenAI Realtime model.
 * These guide the conversation approach and style.
 */
const SYSTEM_MESSAGE = `
AI agent for the company Insurly, an automobile insurance pre-screening voice agent, specialized in gathering information. 
You follow a decision tree approach to collect essential claim information. 
For recognized user input, you should store or parse the user’s answers in a stateful conversation. 
Always confirm the user’s statements politely and then ask the next required question.
Repeat the question if you think you didn't get the answer to.
`;

// Store each call’s conversation state by streamSid.
const conversationStates = {};

// For debugging or logging what kind of events to display
const LOG_EVENT_TYPES = [
  // 'error',
  // 'response.content.done',
  // 'response.done',
  // 'input_audio_buffer.committed',
  // 'session.created'
];

// Toggle for debugging time-based truncation logic
const SHOW_TIMING_MATH = false;

/******************************************************
 * Decision Tree Flows
 * 
 * We define a main flow that asks for:
 * 1) policyId
 * 2) claimType
 * 
 * Then we branch to sub-flows:
 * - car accident
 * - theft
 * - vandalism
 *****************************************************/
const mainFlow = [
  { name: 'policyId',   question: 'First, can you please tell me your policy ID?' },
  { name: 'claimType',  question: 'Great, now please describe the nature of your claim: Car accident, theft, or vandalism?' }
];

const carAccidentFlow = [
  { name: 'alcoholInvolvement', question: 'Was there any alcohol involved from either side? Please say "yes" or "no" or any details.' },
  { name: 'accidentSeverity',   question: 'How severe was the accident? (For example, minor fender-bender, moderate damage, or total loss?)' },
  { name: 'accidentInjuries',   question: 'Were there any injuries? If so, please describe them briefly.' },
  { name: 'accidentComplete',   question: 'Thank you. I believe I have all details for a car accident. Anything else you would like to add?' }
];

const theftFlow = [
  { name: 'theftLocation',      question: 'Where did the theft occur? (public parking lot, street, home, etc.)' },
  { name: 'theftItemsStolen',   question: 'What items or parts were stolen from the vehicle?' },
  { name: 'theftPoliceReport',  question: 'Have you filed a police report? If yes, do you have a report number?' },
  { name: 'theftComplete',      question: 'Alright, thanks for that. Anything else you wish to add about this theft incident?' }
];

const vandalismFlow = [
  { name: 'vandalismDetails',       question: 'Can you describe the vandalism? (e.g., broken windows, spray paint, etc.)' },
  { name: 'vandalismPoliceReport',  question: 'Did you report this vandalism to the authorities? If so, please provide any reference.' },
  { name: 'vandalismComplete',      question: 'Understood. Anything else to add regarding this vandalism incident?' }
];


/*******************************************************
 * Helper: Send an Assistant Message to OpenAI Realtime
 *******************************************************/
function sendAssistantMessage(openAiWs, text) {
  // const conversationItem = {
  //   type: 'conversation.item.create',
  //   item: {
  //     type: 'message',
  //     role: 'assistant',
  //     content: [
  //       {
  //         type: 'input_text',
  //         text
  //       }
  //     ]
  //   }
  // };
  // openAiWs.send(JSON.stringify(conversationItem));

  // // This tells OpenAI to generate an audio response for the newly queued assistant message.
  // openAiWs.send(JSON.stringify({ type: 'response.create' }));
  return;
}


/*******************************************************
 * Step Functions: Decision Tree and Claim Summary
 *******************************************************/

/**
 * finalizeClaim: Called when all claim info is collected or user says "done".
 */
function finalizeClaim(connection, openAiWs, streamSid) {
  const { conversationData } = conversationStates[streamSid] || { conversationData: {} };
  
  let summary = `Here is the summary of your claim:\n`;
  for (const key of Object.keys(conversationData)) {
    summary += `- ${key}: ${conversationData[key]}\n`;
  }
  summary += 'Thank you for providing all the information! We will now proceed to store these details. Have a wonderful day!';
  
  sendAssistantMessage(openAiWs, summary);
}

/**
 * askNextQuestion: Presents the next question from mainFlow or subFlow
 */
function askNextQuestion(connection, openAiWs, streamSid) {
  const state = conversationStates[streamSid];
  if (!state) return;

  const { decisionTreeStep, conversationData, subFlow } = state;

  // If we’re still within mainFlow
  if (decisionTreeStep < mainFlow.length) {
    const nextQuestion = mainFlow[decisionTreeStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
    return;
  }

  // If claimType wasn't recognized => no subFlow
  if (!subFlow) {
    sendAssistantMessage(openAiWs, 'Thanks for that. We currently have minimal details on your claim. Is there anything else you would like to add? Otherwise, say "done".');
    return;
  }

  // Otherwise, continue with the subFlow
  const subFlowQuestions = subFlow.flowArray;
  if (state.subFlowStep < subFlowQuestions.length) {
    const nextQuestion = subFlowQuestions[state.subFlowStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
  } else {
    // Done with subFlow
    finalizeClaim(connection, openAiWs, streamSid);
  }
}

/**
 * handleUserResponse: Called whenever user text arrives from the AI transcript
 */
function handleUserResponse(connection, openAiWs, streamSid, userText) {
  const state = conversationStates[streamSid];
  if (!state) return;

  let { decisionTreeStep, subFlow, subFlowStep, conversationData } = state;

  // If still within mainFlow
  if (decisionTreeStep < mainFlow.length) {
    const questionObj = mainFlow[decisionTreeStep];
    conversationData[questionObj.name] = userText;

    // If we just captured the claimType, we decide which subFlow to set
    if (questionObj.name === 'claimType') {
      const claimType = userText.toLowerCase();
      if (claimType.includes('car')) {
        subFlow = { name: 'carAccidentFlow', flowArray: carAccidentFlow };
      } else if (claimType.includes('theft')) {
        subFlow = { name: 'theftFlow', flowArray: theftFlow };
      } else if (claimType.includes('vandalism')) {
        subFlow = { name: 'vandalismFlow', flowArray: vandalismFlow };
      } else {
        subFlow = null; // unrecognized claim type
      }
      state.subFlow = subFlow;
    }

    state.decisionTreeStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
    return;
  }

  // If mainFlow is done, but subFlow is null (unrecognized or user didn't specify)
  if (!subFlow) {
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      sendAssistantMessage(openAiWs, 'Noted. Anything else you want to add? Or say "done" to finalize.');
    }
    return;
  }

  // Within subFlow
  const subFlowQuestions = subFlow.flowArray;
  if (subFlowStep < subFlowQuestions.length) {
    const questionObj = subFlowQuestions[subFlowStep];
    conversationData[questionObj.name] = userText;
    state.subFlowStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
  } else {
    // SubFlow done, wait for user to say “done”
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      sendAssistantMessage(openAiWs, 'I believe I have all the details. Please say "done" to finalize your claim or add any final comments.');
    }
  }
}


/*******************************************************
 * Define Routes
 *******************************************************/

// Root route just returns a simple status check
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Server is running!' });
});

// The /incoming-call route: TwiML that tells Twilio to connect a WebSocket
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type('text/xml').send(twimlResponse);
});


/*******************************************************
 * The /media-stream route (WebSocket)
 * Twilio will connect here and stream audio in G711 ulaw
 *******************************************************/
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Twilio client connected to /media-stream');

    let streamSid = null;               // unique identifier per call
    let latestMediaTimestamp = 0;       // to track time for audio delta
    let lastAssistantItem = null;       // track item_id for truncation
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Create a dedicated OpenAI Realtime WebSocket FOR THIS CALL
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    /*******************************************************
     * OpenAI WebSocket event handlers
     *******************************************************/
    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API (per-call).');

      // Send session configuration
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
          model: "whisper-1",
          language: "en"
          },
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Immediately greet user as the assistant
      const greeting = 'Hello there! I am your AI assistant for auto insurance claims. Let’s get started!';
      sendAssistantMessage(openAiWs, greeting);
    });

    openAiWs.on('message', (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch (err) {
        console.error('Error parsing OpenAI message:', err);
        return;
      }

      // For debugging, log certain event types
      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`OpenAI event: ${response.type}`, response);
        if (response.type == "error") {
          console.log(response)
        }
      }

      switch (response.type) {
        // The assistant is returning audio deltas
        case 'response.audio.delta':
          if (response.delta) {
            // Send the audio chunk to Twilio
            const audioDelta = {
              event: 'media',
              streamSid,
              media: { payload: response.delta }
            };
            connection.send(JSON.stringify(audioDelta));

            // Record timing for possible truncation if user interrupts
            if (!responseStartTimestampTwilio) {
              responseStartTimestampTwilio = latestMediaTimestamp;
              if (SHOW_TIMING_MATH) {
                console.log(`Starting response at Twilio timestamp: ${responseStartTimestampTwilio}`);
              }
            }
            // Keep track of last item so we can truncate if user interrupts
            if (response.item_id) {
              lastAssistantItem = response.item_id;
            }

            // Add a "mark" to Twilio’s stream
            sendMark(connection, streamSid);
          }
          break;

        // When OpenAI creates a "user" message, it’s basically a text transcription
        case 'conversation.item.create':
          if (response.item?.role === 'user') {
            const userText = response.item?.content?.[0]?.text;
            if (userText) {

            console.log(`User said: ${userText}`);

            // Step the conversation based on user text
            handleUserResponse(connection, openAiWs, streamSid, userText);
            };
          }
          break;

        // Example: if the user started speaking, we might get 'input_audio_buffer.speech_started'
        case 'input_audio_buffer.speech_started':
          handleSpeechStartedEvent();
          break;

          case 'conversation.item.input_audio_transcription.completed':
            fs.writeFileSync('file.txt', '', 'utf8');
            console.log("-- USER --");
            console.log(response.transcript);
            console.log();

        case 'response.audio_transcript.done':
          console.log("-- ASSISTANT --");
          console.log(response.transcript);
          console.log();
          // Additional events come here
          break;
      }
    });

    openAiWs.on('close', () => {
      console.log('OpenAI Realtime WebSocket closed (per-call).');
    });

    openAiWs.on('error', (error) => {
      console.error('OpenAI Realtime WebSocket error:', error);
    });

    function writer(text) {
      fs.writeFile('transcript.txt', text);
      console.log("hello world");
    }
    /*******************************************************
     * Twilio Media Stream event handlers
     *******************************************************/
    connection.on('message', (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (err) {
        console.error('Error parsing Twilio message:', err);
        return;
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          console.log('Twilio stream started for SID:', streamSid);

          // Initialize conversation state for this call
          conversationStates[streamSid] = {
            decisionTreeStep: 0,
            subFlow: null,
            subFlowStep: 0,
            conversationData: {}
          };
          break;

        case 'media':
          // Keep track of timestamp for possible truncation math
          latestMediaTimestamp = data.media.timestamp;
          if (SHOW_TIMING_MATH) {
            console.log(`Received Twilio media at timestamp: ${latestMediaTimestamp}`);
          }

          // Forward raw audio payload to OpenAI
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case 'mark':
          // Twilio acknowledging our mark event
          if (markQueue.length > 0) {
            markQueue.shift();
          }
          break;

        // 'stop' event usually indicates the call ended
        case 'stop':
          console.log(`Twilio stream stopped for SID: ${streamSid}`);
          break;

        default:
          console.log('Received other Twilio event:', data.event);
          break;
      }
    });

    connection.on('close', () => {
      // Cleanup when Twilio connection closes
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      if (streamSid && conversationStates[streamSid]) {
        delete conversationStates[streamSid];
      }
      console.log('Twilio client disconnected.');
    });


    /*******************************************************
     * Helper Functions
     *******************************************************/

    /**
     * handleSpeechStartedEvent:
     * If the user starts talking, we can “truncate” the assistant’s audio so it doesn’t talk over them.
     */
    function handleSpeechStartedEvent() {
      if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(`Speech started, truncation time: ${elapsedTime}ms of assistant audio.`);
        }
        // If the assistant was in the middle of speaking, truncate it
        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }
        // Clear Twilio’s audio buffer so the user can speak
        connection.send(JSON.stringify({ event: 'clear', streamSid }));

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    }

    /**
     * sendMark: We add a "mark" event so Twilio can chunk audio properly
     */
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
  });
});


/*******************************************************
 * Start the Fastify server
 *******************************************************/
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
