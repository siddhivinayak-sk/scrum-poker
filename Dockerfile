# =============================================================================
# Stage 1: Build Angular frontend
# =============================================================================
FROM node:20-alpine AS client-build

WORKDIR /app/client

# Install dependencies first (layer caching)
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Copy shared types (client tsconfig resolves @shared/* to ../shared/*)
COPY shared/ /app/shared/

# Copy client source and build
COPY client/ ./
RUN npm run build -- --configuration=production


# =============================================================================
# Stage 2: Build Node.js backend (compile TypeScript)
# =============================================================================
FROM node:20-alpine AS server-build

WORKDIR /app

# Copy shared types (server tsconfig includes ../shared/**)
COPY shared/ ./shared/

# Install server dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

# Copy server source and compile
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npx tsc


# =============================================================================
# Stage 3: Production image
# =============================================================================
FROM node:20-alpine AS production

WORKDIR /app

# Install production dependencies only for the server
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# Copy compiled server output (includes shared types compiled alongside)
# Server tsconfig has rootDir=".." so output is at dist/server/src/ and dist/shared/
COPY --from=server-build /app/server/dist/ ./server/dist/

# Copy Angular build output
# The server references: path.join(__dirname, '../../client/dist/client/browser')
# __dirname in production = /app/server/dist/server/src
# So ../../client/dist/client/browser = /app/server/dist/client/dist/client/browser
# We place the client dist so the relative path resolves correctly
COPY --from=client-build /app/client/dist/ ./server/dist/client/dist/

# Remove source maps from server build if any leaked through
RUN find ./server/dist -name '*.map' -delete 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/dist/server/src/server.js"]
