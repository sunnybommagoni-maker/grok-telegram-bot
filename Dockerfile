FROM node:18-slim

# Set environment variables
ENV PORT=7860
ENV NODE_ENV=production

# Create and define the workspace
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install packages
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose the port used by Hugging Face Spaces
EXPOSE 7860

# Run the server
CMD ["node", "index.js"]
