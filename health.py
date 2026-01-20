import pygame

class HealthToken:
    def __init__(self, x, y, amount=25):
        self.x = x
        self.y = y
        self.amount = amount
        self.radius = 10
        self.rect = pygame.Rect(x - self.radius, y - self.radius, self.radius * 2, self.radius * 2)
    
    def update(self):
        self.rect = pygame.Rect(self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2)
    
    def draw(self, surface):
        # Draw health token as a red circle with green cross
        pygame.draw.circle(surface, (255, 0, 0), (int(self.x), int(self.y)), self.radius)
        pygame.draw.circle(surface, (255, 100, 100), (int(self.x), int(self.y)), self.radius, 2)
        
        # Draw green cross
        pygame.draw.line(surface, (0, 255, 0), (int(self.x - 5), int(self.y)), (int(self.x + 5), int(self.y)), 2)
        pygame.draw.line(surface, (0, 255, 0), (int(self.x), int(self.y - 5)), (int(self.x), int(self.y + 5)), 2)
