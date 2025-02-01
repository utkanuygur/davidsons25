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
// Some are universal, some are specialized if user indicates "Car accident".
const mainFlow = [
  {
    name: 'policyId',
    question: 'First, can you please tell me your policy ID?'
  },
  {
    name: 'claimType',
    question: 'Great, now please describe the nature of your claim, for example: Car accident, theft, or vandalism?'
  },
  // This is a pivot question. If user says "car accident" we go into carAccident subFlow.
  // If user says "theft", we go into theft subFlow. Otherwise, we can do a default subFlow.
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
 * Called after user finishes the entire main flow + sub flow (or if user says "done").
 * This is where you can finalize or push data to Google Sheets, etc.
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
 * If we've exhausted the main flow, we proceed to sub flow if appropriate.
 */
function askNextQuestion(connection, openAiWs, streamSid) {
  const state = conversationStates[streamSid];
  if (!state) return;
  
  const { decisionTreeStep, conversationData, subFlow } = state;
  
  // If we haven't finished the main flow, proceed
  if (decisionTreeStep < mainFlow.length) {
    const nextQuestion = mainFlow[decisionTreeStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
    return;
  }
  
  // If we finished main flow, we check subFlow
  if (!subFlow) {
    // The user provided some claimType we didn't define, or didn't match "car accident"/"theft"/"vandalism"
    // We can ask a fallback question or finalize.
    sendAssistantMessage(openAiWs, 'Thanks for that. We currently have minimal details on your claim. Is there anything else you would like to add? Otherwise, say "done".');
    return;
  }
  
  // We are in a subFlow: carAccidentFlow, theftFlow, or vandalismFlow.
  const subFlowQuestions = subFlow.flowArray;
  if (state.subFlowStep < subFlowQuestions.length) {
    const nextQuestion = subFlowQuestions[state.subFlowStep].question;
    sendAssistantMessage(openAiWs, nextQuestion);
  } else {
    // subFlow done => finalize
    finalizeClaim(connection, openAiWs, streamSid);
  }
}

/**
 * Processes recognized user text to fill the decision tree
 */
function handleUserResponse(connection, openAiWs, streamSid, userText) {
  const state = conversationStates[streamSid];
  if (!state) return;
  
  let { decisionTreeStep, subFlow, subFlowStep, conversationData } = state;
  
  // If we are still in main flow
  if (decisionTreeStep < mainFlow.length) {
    const questionObj = mainFlow[decisionTreeStep];
    conversationData[questionObj.name] = userText;
    
    // Check if the question we just answered is the "claimType"
    if (questionObj.name === 'claimType') {
      // Lower-case the userText to decide the subFlow
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
        // no recognized subFlow => we will just finalize after main flow
        subFlow = null;
      }
      state.subFlow = subFlow;
    }
    
    // Move to next question in main flow
    state.decisionTreeStep += 1;
    askNextQuestion(connection, openAiWs, streamSid);
    return;
  }
  
  // If main flow is done, we might be in subFlow
  if (!subFlow) {
    // If user says "done", finalize
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      // Otherwise, just confirm or ask if there's anything else
      sendAssistantMessage(openAiWs, 'Noted. Anything else you want to add? Or say "done" to finalize.');
    }
    return;
  }
  
  // Otherwise we are in a recognized subFlow
  const subFlowQuestions = subFlow.flowArray;
  if (subFlowStep < subFlowQuestions.length) {
    const questionObj = subFlowQuestions[subFlowStep];
    conversationData[questionObj.name] = userText;
    state.subFlowStep += 1;
    
    askNextQuestion(connection, openAiWs, streamSid);
  } else {
    // If user still says something after subFlow complete, we finalize or ask if done
    if (userText.toLowerCase().includes('done')) {
      finalizeClaim(connection, openAiWs, streamSid);
    } else {
      sendAssistantMessage(openAiWs, 'I believe I have all the details. Please say "done" to finalize your claim or add any final comments.');
    }
  }
}

/**
 * Sends a message from the "assistant" to the user via the Realtime API
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
  
  // Then, we must trigger the response creation so it actually gets spoken.
  openAiWs.send(JSON.stringify({ type: 'response.create' }));
}

//
//
// =============== SERVER SETUP ===============
//
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
      <Pause length="1"/>
      <Say>O.K. you can start talking!</Say>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Create a WebSocket to connect to OpenAI Realtime
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    // Initialize session with the Realtime API
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

    // Optionally have the AI speak first with a greeting
    const sendGreeting = () => {
      const greeting = `Hello there! I am your AI voice assistant for auto insurance claims. 
                        I’ll collect some details about your claim. Let’s get started!`;

      sendAssistantMessage(openAiWs, greeting);
    };

    //
    // ============= OPENAI WS EVENT HANDLERS =============
    //
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(() => {
        initializeSession();
        // Let’s greet the user right away:
        setTimeout(sendGreeting, 500);
      }, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // --- Audio Deltas: forward to Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          // The first delta from a new response sets the start timestamp
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
            }
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }
          
          // We send a small 'mark' to keep Twilio from speaking over itself
          sendMark(connection, streamSid);
        }

        // --- If user speech starts
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        // --- If the user says something recognized by the Realtime API
        // The recognized user text typically arrives in:
        //    type = 'conversation.item.create'
        //    item.role = 'user'
        if (response.type === 'conversation.item.create' && response.item?.role === 'user') {
          const userText = response.item?.content?.[0]?.text;
          if (!userText) return; // If there's no recognized text, skip
          console.log(`User said: ${userText}`);

          // Pass user text to decision tree logic
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

          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream has started', streamSid);

            // Initialize conversation state for this new call
            conversationStates[streamSid] = {
              decisionTreeStep: 0,
              subFlow: null,
              subFlowStep: 0,
              conversationData: {}
            };

            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
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
      // Cleanup conversation state
      if (streamSid && conversationStates[streamSid]) {
        delete conversationStates[streamSid];
      }
      console.log('Client disconnected.');
    });

    //
    // ============= HELPER FUNCTIONS =============
    //
    function handleSpeechStartedEvent() {
      // If Twilio begins capturing new speech while we were still speaking:
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

        // Send 'clear' to Twilio
        connection.send(JSON.stringify({
          event: 'clear',
          streamSid
        }));

        // Reset
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

/**
 * We replicate the sendAssistantMessage function here again if you want it
 * as a separate utility, but it's above for clarity.
 * 
 * function sendAssistantMessage(openAiWs, text) {
 *   const conversationItem = {
 *     type: 'conversation.item.create',
 *     item: {
 *       type: 'message',
 *       role: 'assistant',
 *       content: [
 *         {
 *           type: 'input_text',
 *           text
 *         }
 *       ]
 *     }
 *   };
 *   openAiWs.send(JSON.stringify(conversationItem));
 *   openAiWs.send(JSON.stringify({ type: 'response.create' }));
 * }
 */
