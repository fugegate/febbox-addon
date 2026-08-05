'use strict';

const { createApp } = require('./index');
const logger = require('../logging/logger');

const PORT = process.env.PORT || 7000;

const app = createApp();
app.listen(PORT, () => {
  logger.info('server_started', { port: Number(PORT), env: process.env.NODE_ENV || 'development' });
});
