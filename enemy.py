import pygame
import math
import random
from src.projectile import Projectile

class Enemy:
    def __init__(self, x, y, radius, color):
        self.x = x
        self.y = y
        self.radius = radius
        self.color = color
        self.vel_x = 0
        self.vel_y = 0
        self.speed = 3
        self.health = 50
        self.max_health = 50
        self.shoot_cooldown = 0
        self.shoot_delay = 60
        self.target = None
        self.move_direction = random.choice([-1, 1])
        self.direction_change_counter = 0
        self.rect = pygame.Rect(x - radius, y - radius, radius * 2, radius * 2)
        
        # Enhanced AI
        self.super_meter = 0.0
        self.super_max = 100.0
        self.super_charge_per_hit = 25.0
        self.super_cooldown = 0
        self.super_cooldown_delay = 30
        self.dodge_timer = 0
        self.dodge_cooldown = 0
    
    def update(self, screen_width, screen_height, player_projectiles=None):
        # Enhanced AI: smarter movement with dodging
        self.direction_change_counter -= 1
        
        # Dodging behavior: if enemy projectiles are nearby, try to dodge
        if player_projectiles:
            for proj in player_projectiles:
                dist = math.sqrt((proj.x - self.x)**2 + (proj.y - self.y)**2)
                if dist < 150 and self.dodge_cooldown <= 0:  # Projectile in danger zone
                    # Move perpendicular to projectile velocity
                    self.vel_x = -proj.vel_y * 0.5
                    self.vel_y = proj.vel_x * 0.5
                    self.dodge_timer = 15
                    self.dodge_cooldown = 60
                    break
        
        # Resume normal movement if not dodging
        if self.dodge_timer > 0:
            self.dodge_timer -= 1
        else:
            if self.direction_change_counter <= 0:
                self.move_direction = random.choice([-1, 0, 1])
                self.direction_change_counter = random.randint(30, 90)
            self.vel_x = self.move_direction * self.speed
        
        if self.dodge_cooldown > 0:
            self.dodge_cooldown -= 1
        
        # Stay within bounds
        if self.x < self.radius:
            self.x = self.radius
        elif self.x > screen_width - self.radius:
            self.x = screen_width - self.radius
        
        if self.y < self.radius:
            self.y = self.radius
        elif self.y > screen_height - self.radius:
            self.y = screen_height - self.radius
        
        self.x += self.vel_x
        self.y += self.vel_y
        
        # Update cooldown
        if self.shoot_cooldown > 0:
            self.shoot_cooldown -= 1
        
        # Update Super cooldown
        if self.super_cooldown > 0:
            self.super_cooldown -= 1
        
        # Update rect
        self.rect = pygame.Rect(self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2)
    
    def shoot_at(self, target):
        if self.shoot_cooldown <= 0:
            self.shoot_cooldown = self.shoot_delay
            
            # Calculate direction to target
            dx = target.x - self.x
            dy = target.y - self.y
            distance = math.sqrt(dx**2 + dy**2)
            
            if distance > 0:
                angle = math.atan2(dy, dx)
                projectile_speed = 8
                
                proj_x = self.x + math.cos(angle) * (self.radius + 10)
                proj_y = self.y + math.sin(angle) * (self.radius + 10)
                
                # Charge super meter when shooting
                self.super_meter = min(self.super_max, self.super_meter + self.super_charge_per_hit)
                
                return Projectile(proj_x, proj_y,
                                math.cos(angle) * projectile_speed,
                                math.sin(angle) * projectile_speed,
                                owner="enemy", damage=15, color=(255, 100, 0))
        
        return None
    
    def fire_super(self):
        """Fire a directional Super projectile if meter is full."""
        if self.super_meter >= self.super_max and self.super_cooldown <= 0:
            self.super_meter = 0.0
            self.super_cooldown = self.super_cooldown_delay
            
            # Calculate direction to a random nearby point (or player if close)
            angle = random.uniform(0, 2 * math.pi)
            projectile_speed = 14
            proj_radius = 25
            proj_x = self.x + math.cos(angle) * (self.radius + proj_radius + 4)
            proj_y = self.y + math.sin(angle) * (self.radius + proj_radius + 4)
            
            return Projectile(proj_x, proj_y,
                              math.cos(angle) * projectile_speed,
                              math.sin(angle) * projectile_speed,
                              owner="enemy_super", damage=100, color=(255, 100, 200), radius=proj_radius)
        return None
    
    def take_damage(self, damage):
        self.health -= damage
    
    def draw(self, surface):
        # Draw body
        pygame.draw.circle(surface, self.color, (int(self.x), int(self.y)), self.radius)
        
        # Draw eyes
        pygame.draw.circle(surface, (255, 255, 255), (int(self.x - 5), int(self.y - 3)), 3)
        pygame.draw.circle(surface, (255, 255, 255), (int(self.x + 5), int(self.y - 3)), 3)
        pygame.draw.circle(surface, (0, 0, 0), (int(self.x - 5), int(self.y - 3)), 1)
        pygame.draw.circle(surface, (0, 0, 0), (int(self.x + 5), int(self.y - 3)), 1)
        
        # Draw health bar
        bar_width = 60
        bar_height = 8
        bar_x = self.x - bar_width // 2
        bar_y = self.y - self.radius - 25
        
        pygame.draw.rect(surface, (255, 0, 0), (bar_x, bar_y, bar_width, bar_height))
        pygame.draw.rect(surface, (0, 255, 0), (bar_x, bar_y, bar_width * (self.health / self.max_health), bar_height))
        pygame.draw.rect(surface, (255, 255, 255), (bar_x, bar_y, bar_width, bar_height), 1)
