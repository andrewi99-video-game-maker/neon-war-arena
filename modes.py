import pygame
import math
import random
from src.map import Wall

class GameMode:
    """Base class for game modes"""
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.game_over = False
        self.winner = None
    
    def update(self, player, enemies, projectiles):
        """Update mode-specific logic. Override in subclasses."""
        pass
    
    def draw_ui(self, surface, font, player, enemies):
        """Draw mode-specific UI. Override in subclasses."""
        pass
    
    def check_win_condition(self, player, enemies):
        """Check if anyone has won. Override in subclasses."""
        pass


class Knockout(GameMode):
    """Knockout: Eliminate all enemies"""
    def __init__(self, width, height):
        super().__init__(width, height)
        self.mode_name = "Knockout"
        
        # Create walls for strategic gameplay (ported from GemGrab)
        self.walls = self._create_walls()
        
    def _create_walls(self):
        """Create walls around the arena"""
        walls = []
        center_x = self.width // 2
        center_y = self.height // 2
        
        # Four corner walls for cover
        walls.append(Wall(center_x - 300, center_y - 250, 120, 150))  # Top-left
        walls.append(Wall(center_x + 180, center_y - 250, 120, 150))  # Top-right
        walls.append(Wall(center_x - 300, center_y + 100, 120, 150))  # Bottom-left
        walls.append(Wall(center_x + 180, center_y + 100, 120, 150))  # Bottom-right
        
        # Middle walls for more cover
        walls.append(Wall(center_x - 80, center_y - 120, 160, 80))  # Top-center
        walls.append(Wall(center_x - 80, center_y + 40, 160, 80))   # Bottom-center
        
        return walls
    
    def check_win_condition(self, player, enemies):
        if player.health <= 0:
            self.game_over = True
            self.winner = "GAME OVER - You Lost!"
            return True
        elif len(enemies) == 0:
            self.game_over = True
            self.winner = "VICTORY - Knockout!"
            return True
        return False
    
    def draw_ui(self, surface, font, player, enemies):
        # Draw walls
        for wall in self.walls:
            wall.draw(surface)
            
        text = font.render(f"Mode: {self.mode_name} | Enemies Remaining: {len(enemies)}", True, (255, 255, 0))
        surface.blit(text, (self.width // 2 - text.get_width() // 2, 20))


class BrawlBall(GameMode):
    """Soccer-like: Shoot ball into enemy goal"""
    def __init__(self, width, height):
        super().__init__(width, height)
        self.mode_name = "Brawl Ball"
        self.ball_x = width // 2
        self.ball_y = height // 2
        self.ball_radius = 10
        self.ball_vel_x = 0
        self.ball_vel_y = 0
        self.ball_friction = 0.95
        self.player_score = 0
        self.enemy_score = 0
        self.goals_to_win = 2
    
    def update(self, player, enemies, projectiles):
        # Ball physics
        self.ball_vel_x *= self.ball_friction
        self.ball_vel_y *= self.ball_friction
        self.ball_x += self.ball_vel_x
        self.ball_y += self.ball_vel_y
        
        # Ball stays in bounds
        if self.ball_x - self.ball_radius < 0:
            self.ball_x = self.ball_radius
            self.ball_vel_x *= -0.8
        if self.ball_x + self.ball_radius > self.width:
            self.ball_x = self.width - self.ball_radius
            self.ball_vel_x *= -0.8
        if self.ball_y - self.ball_radius < 0:
            self.ball_y = self.ball_radius
            self.ball_vel_y *= -0.8
        if self.ball_y + self.ball_radius > self.height:
            self.ball_y = self.height - self.ball_radius
            self.ball_vel_y *= -0.8
        
        # Check if player pushes ball
        dist_to_ball = math.sqrt((player.x - self.ball_x)**2 + (player.y - self.ball_y)**2)
        if dist_to_ball < player.radius + self.ball_radius:
            dx = self.ball_x - player.x
            dy = self.ball_y - player.y
            if math.sqrt(dx**2 + dy**2) > 0:
                angle = math.atan2(dy, dx)
                self.ball_vel_x = math.cos(angle) * 8
                self.ball_vel_y = math.sin(angle) * 8
        
        # Check if enemy pushes ball
        for enemy in enemies:
            dist_to_ball = math.sqrt((enemy.x - self.ball_x)**2 + (enemy.y - self.ball_y)**2)
            if dist_to_ball < enemy.radius + self.ball_radius:
                dx = self.ball_x - enemy.x
                dy = self.ball_y - enemy.y
                if math.sqrt(dx**2 + dy**2) > 0:
                    angle = math.atan2(dy, dx)
                    self.ball_vel_x = math.cos(angle) * 6
                    self.ball_vel_y = math.sin(angle) * 6
        
        # Check goals
        # Player goal (right side)
        if self.ball_x > self.width - 50 and 100 < self.ball_y < self.height - 100:
            self.enemy_score += 1
            self.reset_ball()
        
        # Enemy goal (left side)
        if self.ball_x < 50 and 100 < self.ball_y < self.height - 100:
            self.player_score += 1
            self.reset_ball()
    
    def reset_ball(self):
        self.ball_x = self.width // 2
        self.ball_y = self.height // 2
        self.ball_vel_x = 0
        self.ball_vel_y = 0
    
    def check_win_condition(self, player, enemies):
        if player.health <= 0:
            self.game_over = True
            self.winner = "GAME OVER - You Lost!"
            return True
        elif len(enemies) == 0:
            self.game_over = True
            self.winner = f"VICTORY - Final Score: {self.player_score} - {self.enemy_score}"
            return True
        elif self.player_score >= self.goals_to_win:
            self.game_over = True
            self.winner = f"VICTORY - {self.player_score} goals!"
            return True
        elif self.enemy_score >= self.goals_to_win:
            self.game_over = True
            self.winner = "GAME OVER - Enemies scored more!"
            return True
        return False
    
    def draw_ui(self, surface, font, player, enemies):
        # Draw goals (zones)
        pygame.draw.rect(surface, (100, 200, 100), (self.width - 60, 100, 50, self.height - 200), 3)
        pygame.draw.rect(surface, (200, 100, 100), (10, 100, 50, self.height - 200), 3)
        
        # Draw ball
        pygame.draw.circle(surface, (255, 255, 255), (int(self.ball_x), int(self.ball_y)), self.ball_radius)
        pygame.draw.circle(surface, (200, 200, 200), (int(self.ball_x), int(self.ball_y)), self.ball_radius, 2)
        
        # Draw score
        mode_text = font.render(f"Mode: {self.mode_name}", True, (255, 255, 0))
        score_text = font.render(f"Score: {self.player_score} - {self.enemy_score}", True, (255, 255, 255))
        
        surface.blit(mode_text, (self.width // 2 - mode_text.get_width() // 2, 20))
        surface.blit(score_text, (self.width // 2 - score_text.get_width() // 2, 60))
