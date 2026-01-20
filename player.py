import pygame
import math
from src.projectile import Projectile

class Player:
    def __init__(self, x, y, radius, color):
        self.x = x
        self.y = y
        self.radius = radius
        self.color = color
        self.vel_x = 0
        self.vel_y = 0
        self.speed = 6
        self.health = 100.0
        self.max_health = 100.0

        # Brawl-style ammo: 3 shots, then recharges over time
        self.ammo = 3
        self.max_ammo = 3
        self.shoot_cooldown = 0
        self.shoot_delay = 8  # minimal frames between actual bullet spawns
        # reload timer: when ammo < max_ammo this counts down (frames) until one ammo is restored
        self.reload_timer = 0
        self.reload_delay = 120  # frames to restore one ammo (120 @60fps => 2s)

        # Passive health regeneration (Managed by server for multiplayer sync)
        self.health_regen_rate = 0.0

        # Super meter
        self.super_meter = 0.0
        self.super_max = 100.0
        # how much super charges per successful hit
        self.super_charge_per_hit = 25.0
        # super cooldown (optional) to prevent immediate reuse
        self.super_cooldown = 0
        self.super_cooldown_delay = 30

        self.mouse_angle = 0
        self.rect = pygame.Rect(x - radius, y - radius, radius * 2, radius * 2)
    
    def handle_input(self, keys, screen_width, screen_height, mouse_pos=None):
        # Movement
        self.vel_x = 0
        self.vel_y = 0
        
        if keys[pygame.K_w]:
            self.vel_y = -self.speed
        if keys[pygame.K_s]:
            self.vel_y = self.speed
        if keys[pygame.K_a]:
            self.vel_x = -self.speed
        if keys[pygame.K_d]:
            self.vel_x = self.speed
        
        # Calculate angle to mouse
        if mouse_pos:
            mouse_x, mouse_y = mouse_pos
        else:
            mouse_x, mouse_y = pygame.mouse.get_pos()
            
        dx = mouse_x - self.x
        dy = mouse_y - self.y
        self.mouse_angle = math.atan2(dy, dx)
    
    def update(self, screen_width, screen_height):
        # Update position
        self.x += self.vel_x
        self.y += self.vel_y
        
        # Clamp to screen boundaries
        self.x = max(self.radius, min(self.x, screen_width - self.radius))
        self.y = max(self.radius, min(self.y, screen_height - self.radius))
        
        # Update cooldown
        if self.shoot_cooldown > 0:
            self.shoot_cooldown -= 1
        
        # Passive health regen (frame-based)
        if self.health < self.max_health:
            self.health = min(self.max_health, self.health + (self.health_regen_rate / 60.0))

        # Reload ammo over time when not full
        if self.ammo < self.max_ammo:
            if self.reload_timer > 0:
                self.reload_timer -= 1
            if self.reload_timer <= 0:
                # restore one ammo
                self.ammo += 1
                # if still not full, restart timer, otherwise stop
                if self.ammo < self.max_ammo:
                    self.reload_timer = self.reload_delay
                else:
                    self.reload_timer = 0

        # super cooldown decrement
        if self.super_cooldown > 0:
            self.super_cooldown -= 1

        # Update rect
        self.rect = pygame.Rect(self.x - self.radius, self.y - self.radius, self.radius * 2, self.radius * 2)
    
    def shoot(self):
        # Only shoot if we have ammo and the short shoot_cooldown passed
        if self.shoot_cooldown <= 0 and self.ammo > 0:
            self.shoot_cooldown = self.shoot_delay
            self.ammo -= 1

            if self.ammo < self.max_ammo and self.reload_timer <= 0:
                self.reload_timer = self.reload_delay

            projectile_speed = 15
            proj_x = self.x + math.cos(self.mouse_angle) * (self.radius + 10)
            proj_y = self.y + math.sin(self.mouse_angle) * (self.radius + 10)

            return Projectile(proj_x, proj_y, 
                            math.cos(self.mouse_angle) * projectile_speed,
                            math.sin(self.mouse_angle) * projectile_speed,
                            owner="player", damage=25, color=(255, 255, 0))
        
        return None

    def fire_super(self):
        """Fire a directional Super projectile if meter is full."""
        if self.super_meter >= self.super_max and self.super_cooldown <= 0:
            # consume super
            self.super_meter = 0.0
            self.super_cooldown = self.super_cooldown_delay

            # Super projectile: much larger, slower (for effect), massive damage (one-shot)
            projectile_speed = 10
            proj_radius = 22
            proj_x = self.x + math.cos(self.mouse_angle) * (self.radius + proj_radius + 5)
            proj_y = self.y + math.sin(self.mouse_angle) * (self.radius + proj_radius + 5)

            return Projectile(proj_x, proj_y,
                              math.cos(self.mouse_angle) * projectile_speed,
                              math.sin(self.mouse_angle) * projectile_speed,
                              owner="player", damage=100, color=(0, 200, 255), 
                              radius=proj_radius, is_super=True)
        return None
    
    def take_damage(self, damage):
        self.health -= damage
    
    def get_data(self):
        """Clean data package for network"""
        # Convert objects to simple dicts/tuples
        proj_data = []
        # We don't have direct access to game.projectiles from here easily unless passed in
        # But we can assume the game loop handles projectile gathering. 
        # Actually, let's just send position and keep it simple.
        # The game.py will handle attaching projectiles.
        return {
            "x": self.x,
            "y": self.y,
            "color": self.color
        }

    def draw(self, surface, is_local=True):
        if self.health <= 0:
            return

        # Draw body
        pygame.draw.circle(surface, self.color, (int(self.x), int(self.y)), self.radius)
        
        # Only draw aim indicator for local player
        if is_local:
            indicator_length = self.radius + 15
            end_x = self.x + math.cos(self.mouse_angle) * indicator_length
            end_y = self.y + math.sin(self.mouse_angle) * indicator_length
            pygame.draw.line(surface, (255, 255, 255), (self.x, self.y), (end_x, end_y), 3)
            
            # Ammo bar
            bar_width = 80
            bar_height = 8
            bar_x = self.x - bar_width // 2
            ammo_bar_y = self.y - self.radius - 50
            
            ammo_segment_width = bar_width // self.max_ammo
            for i in range(int(self.max_ammo)):
                segment_x = bar_x + i * ammo_segment_width
                pygame.draw.rect(surface, (100, 100, 100), (segment_x, ammo_bar_y, ammo_segment_width - 1, bar_height))
                if i < self.ammo:
                    pygame.draw.rect(surface, (255, 255, 0), (segment_x, ammo_bar_y, ammo_segment_width - 1, bar_height))
            pygame.draw.rect(surface, (255, 255, 255), (bar_x, ammo_bar_y, bar_width, bar_height), 2)
        
        # Draw health bar (visible for all)
        bar_width = 80 if is_local else 60
        bar_height = 10 if is_local else 8
        bar_offset = 30 if is_local else 25
        bar_x = self.x - bar_width // 2
        health_bar_y = self.y - self.radius - bar_offset
        
        pygame.draw.rect(surface, (255, 0, 0), (bar_x, health_bar_y, bar_width, bar_height))
        # Protect against div by zero or negative
        hp_pct = max(0, self.health / self.max_health)
        pygame.draw.rect(surface, (0, 255, 0), (bar_x, health_bar_y, bar_width * hp_pct, bar_height))
        pygame.draw.rect(surface, (255, 255, 255), (bar_x, health_bar_y, bar_width, bar_height), 2)
