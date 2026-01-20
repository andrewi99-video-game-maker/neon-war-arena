import pygame

class Projectile:
    def __init__(self, x, y, vel_x, vel_y, owner="player", damage=10, color=(255, 255, 0), radius=8, id=None, is_super=False):
        import random
        self.x = x
        self.y = y
        self.vel_x = vel_x
        self.vel_y = vel_y
        self.owner = owner
        self.damage = damage
        self.radius = radius if not is_super else 22
        self.color = color if not is_super else (0, 200, 255)
        self.id = id if id is not None else random.random()
        self.is_super = is_super
        self.rect = pygame.Rect(x - self.radius, y - self.radius, self.radius * 2, self.radius * 2)
    
    def update(self):
        self.x += self.vel_x
        self.y += self.vel_y
        self.rect = pygame.Rect(self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2)
    
    def is_off_screen(self, screen_width, screen_height):
        return (self.x < -100 or self.x > screen_width + 100 or
                self.y < -100 or self.y > screen_height + 100)
    
    def draw(self, surface):
        if not self.is_super:
            # Draw standard projectile
            pygame.draw.circle(surface, self.color, (int(self.x), int(self.y)), self.radius)
            pygame.draw.circle(surface, (255, 255, 255), (int(self.x), int(self.y)), self.radius, 1)
            pygame.draw.circle(surface, (255, 255, 255), (int(self.x), int(self.y)), int(self.radius * 0.3))
        else:
            # Draw Energy Ball (Super)
            import math
            import time
            pulse = math.sin(time.time() * 15) * 5
            base_r = self.radius + pulse
            
            # Inner core
            pygame.draw.circle(surface, (200, 240, 255), (int(self.x), int(self.y)), int(base_r * 0.8))
            pygame.draw.circle(surface, (255, 255, 255), (int(self.x), int(self.y)), int(base_r * 0.4))
            
            # Energy rings/layers
            for i in range(2):
                r = base_r + 10 + (i * 8)
                s = pygame.Surface((r*2, r*2), pygame.SRCALPHA)
                pygame.draw.circle(s, (0, 150, 255, 80 - (i * 30)), (int(r), int(r)), int(r))
                surface.blit(s, (self.x - r, self.y - r))
