#!/bin/bash

# Exit on error
set -e

echo "Deploying minimal CORS fix to Heroku..."

# Create a temporary directory for deployment
TEMP_DIR=$(mktemp -d)
echo "Creating temporary deployment directory at $TEMP_DIR"

# Copy only essential files
mkdir -p "$TEMP_DIR"
cp backend-server.cjs "$TEMP_DIR/"
cp package.json "$TEMP_DIR/"
cp Procfile "$TEMP_DIR/"
cp .env "$TEMP_DIR/" 2>/dev/null || echo "No .env file found, continuing..."

# Create a minimal package.json if needed
if [ ! -f "$TEMP_DIR/package.json" ]; then
  cat > "$TEMP_DIR/package.json" << EOF
{
  "name": "lucy-sounds-analytics-backend",
  "version": "1.0.0",
  "description": "Backend API server for Lucy Sounds Analytics",
  "main": "backend-server.cjs",
  "type": "commonjs",
  "scripts": {
    "start": "node backend-server.cjs"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "axios": "^1.6.0",
    "@supabase/supabase-js": "^2.38.0"
  }
}
EOF
fi

# Create Procfile if needed
if [ ! -f "$TEMP_DIR/Procfile" ]; then
  echo "web: node backend-server.cjs" > "$TEMP_DIR/Procfile"
fi

# Initialize Git repository in the temporary directory
cd "$TEMP_DIR"
git init
git add .
git config --local user.email "deploy@lucysounds.com"
git config --local user.name "Deploy Script"
git commit -m "Deploy CORS fix"

# Get the app name from user input or use default
read -p "Enter your Heroku app name (default: lucy-sounds-analytics-api): " APP_NAME
APP_NAME=${APP_NAME:-lucy-sounds-analytics-api}

echo "Deploying to $APP_NAME..."

# Set the correct buildpacks
echo "Setting Node.js buildpack..."
heroku buildpacks:clear -a $APP_NAME
heroku buildpacks:set heroku/nodejs -a $APP_NAME

# Set environment variables
echo "Setting environment variables..."
heroku config:set NODE_ENV=production -a $APP_NAME
heroku config:set REACT_APP_SUPABASE_URL="$REACT_APP_SUPABASE_URL" -a $APP_NAME
heroku config:set REACT_APP_SUPABASE_ANON_KEY="$REACT_APP_SUPABASE_ANON_KEY" -a $APP_NAME
heroku config:set SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" -a $APP_NAME

# Add Heroku remote and push
heroku git:remote -a $APP_NAME
git push heroku master --force

echo "Deployment complete!"
echo "Your API with fixed CORS should now be available at: https://$APP_NAME.herokuapp.com"
echo "Test the API by visiting: https://$APP_NAME.herokuapp.com/health"

# Cleanup
cd - > /dev/null
rm -rf "$TEMP_DIR" 