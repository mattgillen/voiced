// Local runs: load ./.env (copy .env.example) before anything reads process.env.
// Variables already set in the environment win. Cloud sessions set them in the
// environment's settings instead, and have no .env.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
