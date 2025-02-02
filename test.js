import WebSocket from 'ws';
import fastify from 'server.js'; // ensure the path points to your server.js

describe('Fastify Server Endpoints', () => {
  // Start the server on a dynamic port before tests run.
  beforeAll(async () => {
    // Listen on port 0 (a random available port)
    await fastify.listen({ port: 0 });
  });

  // After tests, close the server.
  afterAll(async () => {
    await fastify.close();
  });

  test('GET / returns a status message', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/'
    });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload.message).toBe('Server is running!');
  });

  test('GET /incoming-call returns valid TwiML', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/incoming-call'
    });
    expect(response.statusCode).toBe(200);
    // Check that the content type is XML and contains the Connect tag.
    expect(response.headers['content-type']).toMatch(/text\/xml/);
    expect(response.payload).toContain('<Connect>');
  });
});

describe('WebSocket /media-stream Endpoint', () => {
  let ws;
  let wsUrl;

  // Before running the WebSocket tests, determine the actual port
  beforeAll(() => {
    const address = fastify.server.address();
    const port = address.port;
    wsUrl = `ws://127.0.0.1:${port}/media-stream`;
  });

  afterEach(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  test('WebSocket connection can be established and responds with mark events', (done) => {
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      // When the connection opens, send a "start" event to simulate Twilio’s initial message.
      ws.send(JSON.stringify({
        event: 'start',
        start: { streamSid: 'testStreamSid' }
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        // Our helper function sends a mark event when there is assistant audio.
        // In this test, we are checking for a mark event.
        if (message.event === 'mark') {
          // If a mark event is received, the WebSocket route is working as expected.
          ws.close();
          done();
        }
      } catch (err) {
        done(err);
      }
    });

    ws.on('error', (err) => {
      done(err);
    });
  });
});
