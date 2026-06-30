#!/bin/bash

# Exit on error
set -e

echo "======================================================"
echo " Deploying BetterPantry PWA Client to GitHub Pages"
echo "======================================================"

# Ensure we are inside the public folder
cd "$(dirname "$0")"

# Initialize git if not already done
if [ ! -d ".git" ]; then
  git init -b main
  echo "Initialized local git repository inside public/"
fi

# Add remote origin
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/AnonymousAssociate1/Better-Pantry-Server.git
echo "Set remote origin to AnonymousAssociate1/Better-Pantry-Server"

# Stage and commit files
git add .
git commit -m "Deploy PWA client to root for GitHub Pages" || echo "No changes to commit"

# Push to GitHub
echo "Pushing code to GitHub..."
echo "If prompted, log in or use your GitHub Personal Access Token (PAT) / SSH Key."
git push -u origin main --force

echo ""
echo "======================================================"
echo " Success! Client files pushed to GitHub."
echo " Ensure GitHub Pages is enabled in repo settings:"
echo " Settings -> Pages -> Deploy from branch (main)"
echo "======================================================"
