#!/usr/bin/env python3
"""
server.py

A single-file Python application that:
- Uses FastAPI for HTTP + WebSockets
- Serves a TwiML endpoint /incoming-call to Twilio
- Accepts Twilio's media WebSocket at /media-stream
- Forwards audio to an OpenAI Realtime WebSocket
- Maintains a decision-tree conversation for auto insurance claims
- Stores transcript to transcript.txt
"""

import os
import json
import asyncio
import websockets  # for OpenAI Realtime client
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any, Optional
import uvicorn

load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("Missing OPENAI_API_KEY in your .env")
    exit(1)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------
PORT = 5050

# This instructs OpenAI's Realtime session how to respond (voice, instructions, etc.)
VOICE = "alloy"
SYSTEM_MESSAGE = """
You are a helpful and friendly AI assistant specialized in gathering information for auto insurance claims. 
You follow a decision tree approach to collect essential claim information. 
For recognized user input, you should store or parse the user’s answers in a stateful conversation. 
Always confirm the user’s statements politely and then ask the next required question.
"""

# If you want to see debugging logs for certain OpenAI event types
LOG_EVENT_TYPES = [
    "error",
    "response.content.done",
    "rate_limits.updated",
    "response.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created"
]

SHOW_TIMING_MATH = False

# ------------------------------------------------------------------------------
# Decision Tree Flows
# ------------------------------------------------------------------------------
mainFlow = [
    {"name": "policyId",  "question": "First, can you please tell me your policy ID?"},
    {"name": "claimType", "question": "Great, now please describe the nature of your claim: Car accident, theft, or vandalism?"}
]

carAccidentFlow = [
    {"name": "alcoholInvolvement", "question": "Was there any alcohol involved? (yes/no/details)"},
    {"name": "accidentSeverity",   "question": "How severe was the accident? (minor, moderate, total loss?)"},
    {"name": "accidentInjuries",   "question": "Were there any injuries? If so, please describe briefly."},
    {"name": "accidentComplete",   "question": "Thanks. Anything else you'd like to add about the accident?"}
]

theftFlow = [
    {"name": "theftLocation",     "question": "Where did the theft occur? (parking lot, street, home, etc.)"},
    {"name": "theftItemsStolen",  "question": "Which items or parts were stolen?"},
    {"name": "theftPoliceReport", "question": "Have you filed a police report? If yes, do you have a report number?"},
    {"name": "theftComplete",     "question": "Anything else you wish to add about this theft?"}
]

vandalismFlow = [
    {"name": "vandalismDetails",      "question": "Please describe the vandalism (e.g., broken windows, spray paint)."},
    {"name": "vandalismPoliceReport", "question": "Did you report this vandalism to authorities? If so, any reference?"},
    {"name": "vandalismComplete",     "question": "Understood. Anything else to add regarding this vandalism incident?"}
]

# ------------------------------------------------------------------------------
# In-memory conversation state (keyed by Twilio streamSid)
# ------------------------------------------------------------------------------
conversationStates: Dict[str, Dict[str, Any]] = {}

# ------------------------------------------------------------------------------
# Helper: Send an assistant message to the OpenAI Realtime WS
# ------------------------------------------------------------------------------
async def sendAssistantMessage(openai_ws: websockets.WebSocketClientProtocol, text: str):
    """
    Enqueues an assistant message for TTS with OpenAI Realtime.
    Then requests `response.create` to generate audio.
    """
    conversationItem = {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "input_text", "text": text}]
        }
    }
    await openai_ws.send(json.dumps(conversationItem))

    # Prompt the server to start generating audio
    await openai_ws.send(json.dumps({"type": "response.create"}))


# ------------------------------------------------------------------------------
# Decision Tree Logic
# ------------------------------------------------------------------------------
async def finalizeClaim(streamSid: str, openai_ws: websockets.WebSocketClientProtocol):
    """
    Called when user says 'done' or we have all needed claim info.
    """
    state = conversationStates.get(streamSid, {})
    conversationData = state.get("conversationData", {})
    summary = "Here is the summary of your claim:\n"
    for key, val in conversationData.items():
        summary += f"- {key}: {val}\n"
    summary += "Thank you! We'll store these details. Have a wonderful day!"

    await sendAssistantMessage(openai_ws, summary)


async def askNextQuestion(streamSid: str, openai_ws: websockets.WebSocketClientProtocol):
    """
    Decides which question to ask next based on mainFlow or subFlow progress.
    """
    state = conversationStates.get(streamSid)
    if not state:
        return

    dtStep = state["decisionTreeStep"]
    subFlow = state["subFlow"]
    subFlowStep = state["subFlowStep"]

    # Are we still in mainFlow?
    if dtStep < len(mainFlow):
        nextQ = mainFlow[dtStep]["question"]
        await sendAssistantMessage(openai_ws, nextQ)
        return

    # If there's no recognized subFlow
    if not subFlow:
        msg = "We have minimal details for your claim. Anything else to add? Otherwise say 'done'."
        await sendAssistantMessage(openai_ws, msg)
        return

    # Subflow handling
    flowArray = subFlow["flowArray"]
    if subFlowStep < len(flowArray):
        nextQ = flowArray[subFlowStep]["question"]
        await sendAssistantMessage(openai_ws, nextQ)
    else:
        # Done with subFlow
        await finalizeClaim(streamSid, openai_ws)


async def handleUserResponse(
    streamSid: str,
    openai_ws: websockets.WebSocketClientProtocol,
    userText: str
):
    """
    Called when we get a "user" text message from OpenAI's transcript.
    """
    state = conversationStates.get(streamSid)
    if not state:
        return

    dtStep = state["decisionTreeStep"]
    subFlow = state["subFlow"]
    sfStep = state["subFlowStep"]
    conversationData = state["conversationData"]

    # If still in mainFlow
    if dtStep < len(mainFlow):
        questionObj = mainFlow[dtStep]
        conversationData[questionObj["name"]] = userText

        # If we just got claimType, set up subFlow
        if questionObj["name"] == "claimType":
            claimType = userText.lower()
            if "car" in claimType:
                state["subFlow"] = {"name": "carAccidentFlow", "flowArray": carAccidentFlow}
            elif "theft" in claimType:
                state["subFlow"] = {"name": "theftFlow", "flowArray": theftFlow}
            elif "vandal" in claimType:
                state["subFlow"] = {"name": "vandalismFlow", "flowArray": vandalismFlow}
            else:
                state["subFlow"] = None

        state["decisionTreeStep"] += 1
        await askNextQuestion(streamSid, openai_ws)
        return

    # If mainFlow done but subFlow is None
    if not subFlow:
        if "done" in userText.lower():
            await finalizeClaim(streamSid, openai_ws)
        else:
            msg = "Noted. Anything else? Or say 'done' to finalize."
            await sendAssistantMessage(openai_ws, msg)
        return

    # If in subFlow
    flowArray = subFlow["flowArray"]
    if sfStep < len(flowArray):
        questionObj = flowArray[sfStep]
        conversationData[questionObj["name"]] = userText
        state["subFlowStep"] += 1
        await askNextQuestion(streamSid, openai_ws)
    else:
        # SubFlow is complete
        if "done" in userText.lower():
            await finalizeClaim(streamSid, openai_ws)
        else:
            msg = "We have most details. Say 'done' to finalize or add more info."
            await sendAssistantMessage(openai_ws, msg)


# ------------------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------------------
@app.get("/")
async def root():
    return {"message": "Python Twilio + OpenAI Realtime server is running!"}


@app.post("/incoming-call")
@app.get("/incoming-call")  # Allow GET or POST
def incoming_call(request: Request):
    """
    Returns TwiML that instructs Twilio to connect audio to /media-stream.
    """
    host = request.headers.get("host", "localhost:5050")
    twiml_response = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://{host}/media-stream" />
  </Connect>
</Response>
"""
    return Response(content=twiml_response, media_type="text/xml")


# ------------------------------------------------------------------------------
# WebSocket Endpoint: /media-stream for Twilio
# ------------------------------------------------------------------------------
@app.websocket("/media-stream")
async def media_stream_endpoint(twilio_ws: WebSocket):
    """
    Twilio calls connect here, sending G.711 μ-law audio in JSON frames.
    We'll open a second WS to OpenAI Realtime, forwarding user audio
    and receiving assistant audio.
    """
    await twilio_ws.accept()
    streamSid: Optional[str] = None

    # State for audio timing/truncation
    latestMediaTimestamp = 0
    lastAssistantItem = None
    markQueue = []
    responseStartTimestampTwilio = None

    # Connect to OpenAI Realtime for *this* call
    openai_uri = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17"
    extra_headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "OpenAI-Beta": "realtime=v1"
    }

    async with websockets.connect(openai_uri, extra_headers=extra_headers) as openai_ws:
        # Once open, configure the session
        session_update = {
            "type": "session.update",
            "session": {
                "turn_detection": {"type": "server_vad"},
                "input_audio_format": "g711_ulaw",
                "output_audio_format": "g711_ulaw",
                "voice": VOICE,
                "instructions": SYSTEM_MESSAGE,
                "modalities": ["text", "audio"],
                "temperature": 0.8
            }
        }
        await openai_ws.send(json.dumps(session_update))

        # Send an initial greeting as the assistant
        greeting = "Hello there! I am your AI assistant for auto insurance claims. Let's get started!"
        await sendAssistantMessage(openai_ws, greeting)

        # We'll consume messages from OpenAI and Twilio simultaneously
        consumer_task = asyncio.create_task(
            handle_openai_messages(openai_ws, twilio_ws,
                                   lambda: streamSid,
                                   lambda: latestMediaTimestamp,
                                   lambda: markQueue,
                                   lambda: responseStartTimestampTwilio,
                                   lambda: lastAssistantItem,
                                   handleUserResponse)
        )
        producer_task = asyncio.create_task(
            handle_twilio_messages(twilio_ws, openai_ws,
                                   lambda: streamSid,
                                   lambda val: set_streamSid(val),
                                   lambda: latestMediaTimestamp,
                                   lambda val: set_latestMediaTimestamp(val),
                                   lambda: responseStartTimestampTwilio,
                                   lambda val: set_responseStartTimestamp(val),
                                   lambda: lastAssistantItem,
                                   lambda val: set_lastAssistantItem(val),
                                   markQueue)
        )

        # Wait until either Twilio or OpenAI disconnect
        done, pending = await asyncio.wait(
            [consumer_task, producer_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        for task in pending:
            task.cancel()

    # Cleanup conversation state
    if streamSid and streamSid in conversationStates:
        del conversationStates[streamSid]

    # Inner helper to set streamSid
    def set_streamSid(val):
        nonlocal streamSid
        streamSid = val

    # Set latestMediaTimestamp
    def set_latestMediaTimestamp(val):
        nonlocal latestMediaTimestamp
        latestMediaTimestamp = val

    # Set responseStartTimestampTwilio
    def set_responseStartTimestamp(val):
        nonlocal responseStartTimestampTwilio
        responseStartTimestampTwilio = val

    # Set lastAssistantItem
    def set_lastAssistantItem(val):
        nonlocal lastAssistantItem
        lastAssistantItem = val


# ------------------------------------------------------------------------------
# Async helpers for reading/writing Twilio and OpenAI websockets concurrently
# ------------------------------------------------------------------------------

async def handle_twilio_messages(
    twilio_ws: WebSocket,
    openai_ws: websockets.WebSocketClientProtocol,
    get_streamSid,
    set_streamSid,
    get_latestMediaTimestamp,
    set_latestMediaTimestamp,
    get_responseStartTimestamp,
    set_responseStartTimestamp,
    get_lastAssistantItem,
    set_lastAssistantItem,
    markQueue
):
    """
    Reads messages from Twilio, forwards audio to OpenAI, and updates local state.
    """
    try:
        while True:
            data = await twilio_ws.receive_text()
            msg = json.loads(data)

            event = msg.get("event")
            if event == "start":
                sid = msg["start"]["streamSid"]
                set_streamSid(sid)
                print("Twilio stream started:", sid)
                conversationStates[sid] = {
                    "decisionTreeStep": 0,
                    "subFlow": None,
                    "subFlowStep": 0,
                    "conversationData": {}
                }
                # Optional: mark the start of a new call in the transcript
                with open("transcript.txt", "a", encoding="utf-8") as f:
                    f.write(f"\n--- New call started: streamSid={sid} ---\n")

            elif event == "media":
                # user audio payload
                payload = msg["media"]["payload"]
                timestamp = msg["media"]["timestamp"]
                set_latestMediaTimestamp(timestamp)

                # Forward to OpenAI
                audioAppend = {
                    "type": "input_audio_buffer.append",
                    "audio": payload
                }
                if openai_ws and openai_ws.open:
                    await openai_ws.send(json.dumps(audioAppend))

            elif event == "mark":
                # Twilio acknowledges our mark
                if markQueue:
                    markQueue.pop(0)

            elif event == "stop":
                print(f"Twilio stream stopped for {get_streamSid()}")
                # Optional: mark the end of the call in the transcript
                sid = get_streamSid()
                if sid:
                    with open("transcript.txt", "a", encoding="utf-8") as f:
                        f.write(f"--- Call ended: streamSid={sid} ---\n\n")
                return  # End read loop

            else:
                # Other Twilio events (e.g., we can ignore or log)
                pass

    except WebSocketDisconnect:
        print("Twilio WebSocket disconnected.")


async def handle_openai_messages(
    openai_ws: websockets.WebSocketClientProtocol,
    twilio_ws: WebSocket,
    get_streamSid,
    get_latestMediaTimestamp,
    get_markQueue,
    get_responseStartTimestamp,
    get_lastAssistantItem,
    handleUserResponseFn
):
    """
    Reads events from OpenAI Realtime, streams assistant audio to Twilio,
    and handles user transcripts for the claim conversation.
    Also logs user and assistant messages to transcript.txt.
    """
    try:
        async for raw_msg in openai_ws:
            try:
                response = json.loads(raw_msg)
            except:
                print("Error parsing OpenAI message:", raw_msg)
                continue

            # Debug certain events
            if response.get("type") in LOG_EVENT_TYPES:
                print("OpenAI event:", response["type"], response)

            if response["type"] == "response.audio.delta":
                # Stream assistant audio to Twilio
                delta = response.get("delta")
                if delta:
                    out_msg = {
                        "event": "media",
                        "streamSid": get_streamSid(),
                        "media": {"payload": delta}
                    }
                    await twilio_ws.send_json(out_msg)

                # Send a "mark" to Twilio so it knows to chunk the audio
                await send_mark(twilio_ws, get_streamSid(), get_markQueue())

            elif response["type"] == "conversation.item.create":
                # Check for user or assistant messages
                item = response.get("item", {})
                role = item.get("role")
                if role in ["user", "assistant"]:
                    # Extract the text from content array
                    text_chunks = []
                    for c in item.get("content", []):
                        if "text" in c:
                            text_chunks.append(c["text"])
                    combined_text = " ".join(text_chunks)

                    # Append to transcript.txt
                    with open("transcript.txt", "a", encoding="utf-8") as f:
                        f.write(f"{role.capitalize()}: {combined_text}\n")

                    # If user, pass to handleUserResponse
                    if role == "user":
                        sid = get_streamSid()
                        if sid:
                            await handleUserResponseFn(sid, openai_ws, combined_text)

            elif response["type"] == "input_audio_buffer.speech_started":
                # If the user starts speaking while the assistant is talking,
                # we can truncate the assistant's audio so it doesn't talk over the user.
                await handle_speech_started_event(
                    twilio_ws,
                    openai_ws,
                    get_streamSid(),
                    get_latestMediaTimestamp(),
                    get_responseStartTimestamp,
                    get_lastAssistantItem
                )

            else:
                # Other events like session updates, rate_limits, etc.
                pass

    except websockets.ConnectionClosedError:
        print("OpenAI websocket closed.")


# ------------------------------------------------------------------------------
# Additional Helpers
# ------------------------------------------------------------------------------
async def send_mark(
    twilio_ws: WebSocket,
    streamSid: Optional[str],
    markQueue: list
):
    """
    Insert a "mark" event so Twilio can chunk the assistant audio properly.
    """
    if streamSid:
        mark_event = {
            "event": "mark",
            "streamSid": streamSid,
            "mark": {"name": "responsePart"}
        }
        await twilio_ws.send_json(mark_event)
        markQueue.append("responsePart")


async def handle_speech_started_event(
    twilio_ws: WebSocket,
    openai_ws: websockets.WebSocketClientProtocol,
    streamSid: Optional[str],
    latestMediaTimestamp: int,
    get_responseStartTimestamp,
    get_lastAssistantItem
):
    """
    If the user starts speaking while the assistant is talking,
    we can truncate the assistant's audio so it doesn't talk over the user.
    """
    responseStartTs = get_responseStartTimestamp()
    if responseStartTs is None:
        return

    elapsedTime = latestMediaTimestamp - responseStartTs
    if SHOW_TIMING_MATH:
        print(f"User started speaking, truncating assistant audio at {elapsedTime} ms.")

    lastItem = get_lastAssistantItem()
    if lastItem:
        # Send conversation.item.truncate
        truncateEvent = {
            "type": "conversation.item.truncate",
            "item_id": lastItem,
            "content_index": 0,
            "audio_end_ms": elapsedTime
        }
        await openai_ws.send(json.dumps(truncateEvent))

    # Clear Twilio's buffer
    if streamSid:
        await twilio_ws.send_json({"event": "clear", "streamSid": streamSid})


# ------------------------------------------------------------------------------
# Main entry point: uvicorn server
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
