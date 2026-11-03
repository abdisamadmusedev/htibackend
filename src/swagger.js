const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'HTI School Management API',
      version: '1.0.0',
      description: 'API documentation for HTI School Management backend',
    },
    servers: [
      {
        url: 'http://localhost:5001',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            role: { type: 'string' },
            isActive: { type: 'boolean' },
          },
        },
        AcademicYear: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            startDate: { type: 'string', format: 'date' },
            endDate: { type: 'string', format: 'date' },
            isActive: { type: 'boolean' },
            status: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  apis: ['./src/modules/**/routes/*.js', './src/modules/**/controllers/*.js', './src/modules/dashboard/dashboardRoutes.js'],
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = swaggerSpec;
