import pygame
import random

class Ammo:
    def __init__(self, x, y, amount=2):
        self.x = x
        self.y = y
        self.amount = amount
        self.radius = 8
        self.rect = pygame.Rect(x - self.radius, y - self.radius, self.radius * 2, self.radius * 2)
    
    def update(self):
        self.rect = pygame.Rect(self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2)
    
    def draw(self, surface):
        # Draw ammo pickup as a yellow square with glow
        pygame.draw.rect(surface, (255, 200, 0), (self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2))
        pygame.draw.rect(surface, (255, 255, 0), (self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2), 2)
        # Draw ammo amount text
        font = pygame.font.Font(None, 16)
        text = font.render(str(self.amount), True, (0, 0, 0))
        surface.blit(text, (self.x - 4, self.y - 4))
