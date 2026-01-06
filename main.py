import pygame
import sys
from src.game import Game

# Initialize Pygame
pygame.init()

# Game settings
# SCREEN_WIDTH = 1920  # Restore this for full HD
# SCREEN_HEIGHT = 1080 # Restore this for full HD
SCREEN_WIDTH = 1920 
SCREEN_HEIGHT = 1080 
FPS = 60

# Mode selection (change this to try different modes)
# Options: "Knockout", "BrawlBall"
GAME_MODE = "Knockout"

# Server Configuration
# If playing on same computer, use "127.0.0.1"
# If playing on LAN, use the Host computer's IP (e.g., "192.168.1.5")
SERVER_IP = "127.0.0.1"

# Create and run game
game = Game(SCREEN_WIDTH, SCREEN_HEIGHT, FPS, GAME_MODE, SERVER_IP)
game.run()

pygame.quit()
sys.exit()
