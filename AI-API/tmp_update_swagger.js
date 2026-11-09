const fs = require('fs');
const p = 'app/src/swagger.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

j.paths['/api/conversations/summaries'] = {
  get: {
    summary: 'List all conversation summaries',
    tags: ['Conversation'],
    responses: {
      '200': {
        description: 'Conversation summaries fetched successfully',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      conversationId: { type: 'string' },
                      summary: { type: 'string' },
                      createdAt: { type: 'string', format: 'date-time' },
                      updatedAt: { type: 'string', format: 'date-time' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '500': { description: 'Internal server error' }
    }
  }
};

j.paths['/api/conversations/{conversationId}/messages'] = {
  get: {
    summary: 'Get conversation messages',
    tags: ['Conversation'],
    parameters: [{ in: 'path', name: 'conversationId', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Conversation messages retrieved successfully',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } }
                }
              }
            }
          }
        }
      },
      '500': { description: 'Internal server error' }
    }
  },
  delete: {
    summary: 'Delete conversation messages',
    tags: ['Conversation'],
    parameters: [{ in: 'path', name: 'conversationId', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Conversation messages deleted successfully',
        content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } }
      },
      '500': { description: 'Internal server error' }
    }
  }
};

j.paths['/api/conversations/{conversationId}/summary/generate'] = {
  post: {
    summary: 'Generate conversation summary',
    tags: ['Conversation'],
    parameters: [{ in: 'path', name: 'conversationId', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Conversation summary generated successfully',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { data: { type: 'object', properties: { conversationId: { type: 'string' }, summary: { type: 'string' }, isUpdate: { type: 'boolean' } } } }
            }
          }
        }
      },
      '404': { description: 'No conversation history found' },
      '500': { description: 'Internal server error' }
    }
  }
};

j.paths['/api/conversations/{conversationId}/summary'] = {
  delete: {
    summary: 'Delete conversation summary',
    tags: ['Conversation'],
    parameters: [{ in: 'path', name: 'conversationId', required: true, schema: { type: 'string' } }],
    responses: {
      '200': {
        description: 'Conversation summary deleted successfully',
        content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } }
      },
      '500': { description: 'Internal server error' }
    }
  }
};

fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('swagger updated');
