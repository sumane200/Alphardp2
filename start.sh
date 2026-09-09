#!/bin/bash
set -e

echo "Installing backend dependencies..."
cd alphardp-web/backend
npm install
echo "Backend dependencies installed"

echo "Starting backend server..."
npm start
