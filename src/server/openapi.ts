// OpenAPI 3.1 description of the Voiced API. Agent platforms that build
// connectors from a spec (Muse custom connectors, GPT actions, etc.) read the
// operation descriptions below, so they are written as instructions to an agent.

export function openapi(base: string) {
  const callId = { name: 'call_id', in: 'path', required: true, schema: { type: 'string' } };
  const call = { $ref: '#/components/schemas/Call' };
  const ok = (schema: object, description = 'OK') => ({ 200: { description, content: { 'application/json': { schema } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Voiced',
      version: '0.1.0',
      description:
        'The phone layer for AI agents. Voiced calls businesses for your user and handles the phone tree (IVR menus, account lookups, bill payments, cancellations, reservations, hold queues), then hands live humans to the user. Card numbers and PINs stay in the Voiced vault; the agent never sees them. This demo build runs simulated phone trees.',
    },
    servers: [{ url: base }],
    security: [{ bearer: [] }, { oauth: ['calls'] }],
    paths: {
      '/v1/businesses': {
        get: {
          operationId: 'listBusinesses',
          summary: 'List businesses Voiced can call',
          description: 'Returns each business with a business_id, an example task, and how well its phone tree is mapped.',
          responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Business' } }),
        },
      },
      '/v1/calls': {
        post: {
          operationId: 'startCall',
          summary: 'Start a call that Voiced handles end to end',
          description:
            'Places the call and returns immediately. Poll getCall (use wait=30) until status is "ended". If pending_request appears, show the user its title, detail and approval_url, or ask them and relay their explicit answer with respondToCall.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    business_id: { type: 'string', description: 'From listBusinesses, e.g. "bedford".' },
                    instructions: { type: 'string', description: "Extra instructions in the user's words." },
                    max_amount: { type: 'number', description: 'Pre-approved payment cap in dollars, before fees.' },
                    max_fee: { type: 'number', description: 'Pre-approved fees in dollars. Default 0.' },
                  },
                  required: ['business_id'],
                },
              },
            },
          },
          responses: { 201: { description: 'Call started', content: { 'application/json': { schema: call } } } },
        },
        get: {
          operationId: 'listCalls',
          summary: "List this user's calls",
          responses: ok({ type: 'array', items: call }),
        },
      },
      '/v1/calls/{call_id}': {
        get: {
          operationId: 'getCall',
          summary: 'Get call status, pending request and result',
          parameters: [
            callId,
            { name: 'wait', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 50 }, description: 'Long-poll up to this many seconds for something that needs attention.' },
          ],
          responses: ok(call),
        },
      },
      '/v1/calls/{call_id}/respond': {
        post: {
          operationId: 'respondToCall',
          summary: "Relay the user's decision on a pending request",
          description: 'Only after the user explicitly approves or declines. Never approve on your own.',
          parameters: [callId],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { request_id: { type: 'string' }, approved: { type: 'boolean' }, choice: { type: 'string' } },
                  required: ['request_id', 'approved'],
                },
              },
            },
          },
          responses: ok(call),
        },
      },
      '/v1/calls/{call_id}/hangup': {
        post: { operationId: 'hangUp', summary: 'End a call now', parameters: [callId], responses: ok(call) },
      },
      '/v1/stats': {
        get: { operationId: 'getStats', summary: 'Completion rate and IVR map coverage', responses: ok({ type: 'object' }) },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'A Voiced API key (vk_...) or an OAuth access token.' },
        oauth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: `${base}/oauth/authorize`,
              tokenUrl: `${base}/oauth/token`,
              scopes: { calls: 'Place and manage calls for the user' },
            },
          },
        },
      },
      schemas: {
        Business: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            business: { type: 'string' },
            phone: { type: 'string' },
            category: { type: 'string' },
            example_task: { type: 'string' },
            simulated: { type: 'boolean' },
            map: { type: 'object', properties: { screens: { type: 'integer' }, calls: { type: 'integer' }, completion_rate: { type: ['number', 'null'] } } },
          },
        },
        Call: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            business: { type: 'string' },
            task: { type: 'string' },
            status: { type: 'string', enum: ['dialing', 'navigating', 'on_hold', 'talking_to_human', 'awaiting_user', 'handing_off', 'user_connected', 'ended'] },
            pending_request: {
              type: ['object', 'null'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['approve_payment', 'approve', 'choose', 'input'] },
                title: { type: 'string' },
                detail: { type: 'string' },
                amount: { type: 'number' },
                fee: { type: 'number' },
                total: { type: 'number' },
                options: { type: 'array', items: { type: 'string' } },
                approval_url: { type: 'string', description: 'Send the user here to approve on Voiced directly.' },
              },
            },
            outcome: { type: ['string', 'null'], enum: ['success', 'failure', null] },
            summary: { type: ['string', 'null'] },
            notes: { type: 'object', additionalProperties: { type: 'string' } },
            metrics: { type: ['object', 'null'] },
            transcript: { type: 'array', items: { type: 'object', properties: { t: { type: 'integer' }, who: { type: 'string' }, text: { type: 'string' } } } },
            watch_url: { type: 'string', description: 'Live view of the call for the user.' },
          },
        },
      },
    },
  };
}
