import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

//
// === CONFIGURATION CONSTANTS ===
//
const SYSTEM_MESSAGE = `
You are a helpful and friendly AI assistant specialized in gathering information for auto insurance claims. 
You follow a decision tree approach to collect essential claim information. 
For recognized user input, you should store or parse the user’s answers in a stateful conversation. 
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

/**
 * A simple in-memory store for conversation data.
 *
 * Keyed by Twilio stream SID, we track:
 *  1) The "decisionTreeStep" (which question we are on).
 *  2) A "conversationData" object storing the user's answers.
 *  3) A "subFlow" for e.g. if the claim is car accident, we go down that path, if theft, different path, etc.
 */
const conversationStates = {};

// Our decision tree questions
const mainFlow = [
  {
    name: 'policyId',
    question: 'First, can you please tell me your policy ID?'
  },
  {
    name: 'claimType',
    question: 'Great, now please describe the nature of your claim, for example: Car accident, theft, or vandalism?'
  },
  // This is a pivot question. Based on the answer to "claimType", we decide on a subFlow.
];

const carAccidentFlow = [
  {
    name: 'alcoholInvolvement',
    question: 'Was there any alcohol involved from either side? Please say "yes" or "no" or any details.'
  },
  {
    name: 'accidentSeverity',
    question: 'How severe was the accident? For example, minor fender-bender, moderate damage, or total loss?'
  },
  {
    name: 'accidentInjuries',
    question: 'Were there any injuries? If so, please describe them briefly.'
  },
  {
    name: 'accidentComplete',
    question: 'Thank you. I believe I have all details for a car accident. Anything else you would like to add regarding this accident?'
  }
];

const theftFlow = [
  {
    name: 'theftLocation',
    question: 'Where did the theft occur? (Example: a public parking lot, street, at home, etc.)'
  },
  {
    name: 'theftItemsStolen',
    question: 'What items or parts were stolen from the vehicle?'
  },
  {
    name: 'theftPoliceReport',
    question: 'Have you filed a police report? If yes, do you have a report number?'
  },
  {
    name: 'theftComplete',
    question: 'Alright, thanks for that. Anything else you wish to add about this theft incident?'
  }
];

const vandalismFlow = [
  {
    name: 'vandalismDetails',
    question: 'Can you describe the vandalism? For instance, broken windows, spray paint, etc.?'
  },
  {
    name: 'vandalismPoliceReport',
    question: 'Did you report this vandalism to the authorities? If so, please provide any reference.'
  },
  {
    name: 'vandalismComplete',
    question: 'Understood. Anything else to add regarding this vandalism incident?'
  }
];

/**
 * Called after the user finishes the entire main flow + sub flow (or if the user says "done").
 * Here you can finalize or push data to external services.
 */
function finalizeClaim(connection, openAiWs, streamSid) {
  const { conversationData } = conversationStates[streamSid] || { conversationData: {} };
  
  // For demonstration, we will just read back the data we collected.
  let summary = `Here is the summary of your claim:\n`;
  Object.keys(conversationData).forEach(key => {
    summary += `- ${key}: ${conversationData[key]}\n`;
  });
  
  summary += 'Thank you for providing all the information! We will now proceed to store these details. Have a wonderful day!';
  
  sendAssistantMessage(openAiWs, summary);
}

/**
 * Decides which question to ask next based on the conversation state.
 */
function askNextQuestion(connection, openAiWs, streamSid) {
  const state = conversationStates[streamSid];
  if (!state) return;
  
  const { decisionTreeStep, conversationData, subFlow } = state;
  
  // If we haven't finished the main flow, proceed with the next main question.
  if (decisionTreeStep < mainFlow.length) {
    const nextQuestion = mainFlow[decisionTreeStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
    return;
  }
  
  // If the main flow is complete, check if a subFlow has been defined.
  if (!subFlow) {
    sendAssistantMessage(openAiWs, 'Thanks for that. We currently have minimal details on your claim. Is there anything else you would like to add? Otherwise, say "done".');
    return;
  }
  
  // We are in a subFlow (carAccidentFlow, theftFlow, or vandalismFlow).
  const subFlowQuestions = subFlow.flowArray;
  if (state.subFlowStep < subFlowQuestions.length) {
    const nextQuestion = subFlowQuestions[state.subFlowStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
  } else {
    // SubFlow is done; finalize the claim.
    finalizeClaim(connection, openAiWs, streamSid);
  }
}

/**
 * Processes recognized user text to fill in the decision tree.
 */
function handleUserResponse(connection, openAiWs, streamSid, userText) {
  const state = conversationStates[streamSid];
  if (!state) return;
  
  let { decisionTreeStep, subFlow, subFlowStep, conversationData } = state;
  
  // Still within the main flow.
  if (decisionTreeStep < mainFlow.length) {
    const questionObj = mainFlow[decisionTreeStep];
    conversationData[questionObj.name] = userText;
    
    // When processing the "claimType" answer, decide on the appropriate subFlow.
    if (questionObj.name === 'claimType') {
      const claimType = userText.toLowerCase();
      if (claimType.includes('car')) {
        subFlow = {
          name: 'carAccidentFlow',
          flowArray: carAccidentFlow
        };
      } else if (claimType.includes('theft')) {
        subFlow = {
          name: 'theftFlow',
          flowArray: theftFlow
        };
      } else if (claimType.includes('vandalism')) {
        subFlow = {
          name: 'vandalismFlow',
          flowArray: vandalismFlow
        };
      } else {
        subFlow = null;
      }
      state.subFlow = subFlow;
    }
    
    // Move to the next question in the main flow.
    state.decisionTreeStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
    return;
  }
  
  // Main flow complete but no subFlow defined.
  if (!subFlow) {
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      sendAssistantMessage(openAiWs, 'Noted. Anything else you want to add? Or say "done" to finalize.');
    }
    return;
  }
  
  // We are in a recognized subFlow.
  const subFlowQuestions = subFlow.flowArray;
  if (subFlowStep < subFlowQuestions.length) {
    const questionObj = subFlowQuestions[subFlowStep];
    conversationData[questionObj.name] = userText;
    state.subFlowStep += 1;
    
    askNextQuestion(connection, openAiWs, streamSid);
  } else {
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      sendAssistantMessage(openAiWs, 'I believe I have all the details. Please say "done" to finalize your claim or add any final comments.');
    }
  }
}

/**
 * Sends a message from the "assistant" to the user via the OpenAI Realtime API.
 */
function sendAssistantMessage(openAiWs, text) {
  const conversationItem = {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'input_text',
          text
        }
      ]
    }
  };
  openAiWs.send(JSON.stringify(conversationItem));
  
  // Trigger the response creation so it gets spoken.
  openAiWs.send(JSON.stringify({ type: 'response.create' }));
}

/**
 * Sends an initial greeting. Now accepts the openAiWs instance as an argument.
 */
function sendGreeting(openAiWs) {
  const greeting = `Hello there! I am your AI voice assistant for auto insurance claims. 
I’ll collect some details about your claim. Let’s get started!`;

  sendAssistantMessage(openAiWs, greeting);
}

//
// =============== SERVER SETUP ===============
//
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls.
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

    // Connection-specific state.
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Create a WebSocket to connect to OpenAI Realtime.
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    // Initialize session with the Realtime API.
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
    // ============= OPENAI WS EVENT HANDLERS =============
    //
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(() => {
        initializeSession();
        // Removed sendGreeting from here.
      }, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // Forward audio deltas to Twilio.
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          // Set the start timestamp for the new response.
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
            }
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }
          
          // Send a small 'mark' to keep Twilio from speaking over itself.
          sendMark(connection, streamSid);
        }

        // Handle user speech starting.
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        // Process recognized user text.
        if (response.type === 'conversation.item.create' && response.item?.role === 'user') {
          const userText = response.item?.content?.[0]?.text;
          if (!userText) return;
          console.log(`User said: ${userText}`);

          // Pass the user text to the decision tree logic.
          handleUserResponse(connection, openAiWs, streamSid, userText);
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error, 'Raw message:', data);
      }
    });

    openAiWs.on('close', () => {
      console.log('Disconnected from the OpenAI Realtime API');
    });

    openAiWs.on('error', (error) => {
      console.error('Error in the OpenAI WebSocket:', error);
    });

    //
    // ============= TWILIO WS EVENT HANDLERS =============
    //
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream has started', streamSid);

            // Initialize conversation state for this new call.
            conversationStates[streamSid] = {
              decisionTreeStep: 0,
              subFlow: null,
              subFlowStep: 0,
              conversationData: {}
            };

            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;

            // Now that we have a valid streamSid and conversation state, send the greeting.
            if (openAiWs.readyState === WebSocket.OPEN) {
              sendGreeting(openAiWs);
            }
            break;

          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH) {
              console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
            }

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
      // Cleanup conversation state.
      if (streamSid && conversationStates[streamSid]) {
        delete conversationStates[streamSid];
      }
      console.log('Client disconnected.');
    });

    //
    // ============= HELPER FUNCTIONS =============
    //
    function handleSpeechStartedEvent() {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
        }

        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          if (SHOW_TIMING_MATH) {
            console.log('Sending truncation event:', JSON.stringify(truncateEvent));
          }
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Send 'clear' to Twilio.
        connection.send(JSON.stringify({
          event: 'clear',
          streamSid
        }));

        // Reset.
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
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
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
