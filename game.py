import pygame
import sys
from src.player import Player
from src.enemy import Enemy
from src.projectile import Projectile
from src.map import Map
from src.modes import Knockout, BrawlBall
from src.network import Network
import random
import math

class Game:
    def __init__(self, width, height, fps, mode_name="Knockout", server_ip="127.0.0.1"):
        self.width = width
        self.height = height
        self.fps = fps
        self.clock = pygame.time.Clock()
        
        # Display setup
        self.screen_width = width
        self.screen_height = height
        # self.screen = pygame.display.set_mode((width, height), pygame.FULLSCREEN) # Restore for Fullscreen
        self.screen = pygame.display.set_mode((width, height))
        pygame.display.set_caption("Brawl Stars Clone")
        
        # Virtual resolution (Standard world size)
        self.WORLD_WIDTH = 1920
        self.WORLD_HEIGHT = 1080
        self.virtual_screen = pygame.Surface((self.WORLD_WIDTH, self.WORLD_HEIGHT))
        
        # Networking
        self.net = Network(server_ip)
        start_data = self.net.getP() # Receive initial pos/id
        
        if start_data is None:
            print("Error: Could not connect to the Python server. Please make sure server.py is running.")
            pygame.quit()
            sys.exit()
        
        # Game state
        self.running = True
        self.font = pygame.font.Font(None, 36)
        self.large_font = pygame.font.Font(None, 72)
        
        # Initialize game objects
        self.map = Map(self.WORLD_WIDTH, self.WORLD_HEIGHT)
        
        # Setup local player from server data
        self.player = Player(start_data["x"], start_data["y"], 25, start_data["color"])
        self.player_id = start_data["id"]
        
        # We'll store other players here to render them
        self.other_players = {}
        
        self.projectiles = []
        
        # Game mode
        if mode_name == "BrawlBall":
            self.mode = BrawlBall(self.WORLD_WIDTH, self.WORLD_HEIGHT)
        else:
            self.mode = Knockout(self.WORLD_WIDTH, self.WORLD_HEIGHT)
        
        self.game_over = False
        self.winner = None
    
    # (Ammo and health pickups removed)
        
    def handle_input(self):
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    self.running = False
            # Mouse click to shoot
            if event.type == pygame.MOUSEBUTTONDOWN:
                if event.button == 1:  # Left mouse button
                    projectile = self.player.shoot()
                    if projectile:
                        self.projectiles.append(projectile)
                elif event.button == 3: # Right mouse button (Super)
                    projectile = self.player.fire_super()
                    if projectile:
                        self.projectiles.append(projectile)
        
        # Scale mouse coordinates for the virtual world
        mx, my = pygame.mouse.get_pos()
        scaled_mx = mx * (self.WORLD_WIDTH / self.screen_width)
        scaled_my = my * (self.WORLD_HEIGHT / self.screen_height)
        
        # Player movement
        keys = pygame.key.get_pressed()
        self.player.handle_input(keys, self.WORLD_WIDTH, self.WORLD_HEIGHT, (scaled_mx, scaled_my))
        
        # Walls logic (GemGrab/Knockout mode)
        walls = []
        if hasattr(self.mode, 'walls'):
            walls = self.mode.walls
    
    def update(self):
        if self.game_over:
            return
        
        walls = []
        if hasattr(self.mode, 'walls'):
            walls = self.mode.walls
        
        # Update LOCAL player
        self.player.update(self.WORLD_WIDTH, self.WORLD_HEIGHT)
        
        # Update LOCAL projectiles
        for projectile in self.projectiles[:]:
            projectile.update()
            if projectile.is_off_screen(self.WORLD_WIDTH, self.WORLD_HEIGHT):
                self.projectiles.remove(projectile)
                continue
             # Check wall collisions
            for wall in walls:
                if wall.collides_with_point(projectile.x, projectile.y, projectile.radius):
                    self.projectiles.remove(projectile)
                    break

        # Prepare data to send
        data_to_send = {
            "x": self.player.x,
            "y": self.player.y,
            "angle": self.player.mouse_angle,
            "projectiles": [{"x": p.x, "y": p.y, "vel_x": p.vel_x, "vel_y": p.vel_y, "id": p.id, "is_super": p.is_super} for p in self.projectiles]
        }
        
        # Send to server and receive World State
        server_data = self.net.send(data_to_send)
        if server_data:
            self.other_players = server_data # This is the dict of all players
            
            # Update local player health/status from server authority
            if self.player_id in self.other_players:
                my_data = self.other_players[self.player_id]
                self.player.health = my_data["health"]
                self.player.super_meter = my_data.get("super_charge", 0)
                
                # Authority Sync: If the server removed a projectile (because it hit something),
                # we must remove it locally too so it disappears.
                server_proj_ids = [p["id"] for p in my_data["projectiles"]]
                self.projectiles = [p for p in self.projectiles if p.id in server_proj_ids]
                
                # Handling respawn logic on client side visual
                if not my_data["alive"]:
                     # Hide player, disable movement?
                     # For now, just let draw handle it (0 health)
                     pass
                else:
                    # If we just respawned (server pos different from local pos significantly?)
                    # Or just trust server pos?
                    # Let's trust server pos if discrepancy is large (respawn)
                    dist = ((self.player.x - my_data["x"])**2 + (self.player.y - my_data["y"])**2)**0.5
                    if dist > 300: # Respawned
                        self.player.x = my_data["x"]
                        self.player.y = my_data["y"]
                        self.projectiles = [] # Clear projectiles on respawn
        
        # Check player-wall collisions
        for wall in walls:
            if wall.collides_with_point(self.player.x, self.player.y, self.player.radius):
                self.player.x, self.player.y = wall.get_collision_response(self.player.x, self.player.y, self.player.radius)
        
        # Update player rect
        self.player.rect = pygame.Rect(self.player.x - self.player.radius, self.player.y - self.player.radius, 
                                       self.player.radius * 2, self.player.radius * 2)
            
    
    def draw(self):
        # Clear virtual screen
        self.virtual_screen.fill((40, 40, 40))
        
        # Draw map
        self.map.draw(self.virtual_screen)
        
        # Draw ALL players from server state
        for p_id, p_data in self.other_players.items():
            if not p_data["alive"]:
                continue
                
            if p_id == self.player_id:
                # Draw local player using local drawing logic (smoother)
                self.player.draw(self.virtual_screen, is_local=True)
            else:
                # Draw remote player
                pygame.draw.circle(self.virtual_screen, p_data["color"], (int(p_data["x"]), int(p_data["y"])), 25)
                
                # Draw remote player aim indicator
                angle = p_data.get("angle", 0)
                indicator_length = 40
                end_x = p_data["x"] + math.cos(angle) * indicator_length
                end_y = p_data["y"] + math.sin(angle) * indicator_length
                pygame.draw.line(self.virtual_screen, (255, 100, 100), (p_data["x"], p_data["y"]), (end_x, end_y), 3)
                
                # Health bar
                pygame.draw.rect(self.virtual_screen, (255, 0, 0), (p_data["x"]-30, p_data["y"]-40, 60, 8))
                hp_pct = max(0, p_data["health"] / 100.0)
                pygame.draw.rect(self.virtual_screen, (0, 255, 0), (p_data["x"]-30, p_data["y"]-40, 60*hp_pct, 8))
                
                # Draw their projectiles
                if "projectiles" in p_data:
                    for proj in p_data["projectiles"]:
                         is_super = proj.get("is_super", False)
                         if not is_super:
                            pygame.draw.circle(self.virtual_screen, (255, 255, 0), (int(proj["x"]), int(proj["y"])), 8)
                         else:
                            # Simple remote super draw (energy ball)
                            r = 22
                            pygame.draw.circle(self.virtual_screen, (0, 200, 255), (int(proj["x"]), int(proj["y"])), r)
                            pygame.draw.circle(self.virtual_screen, (200, 240, 255), (int(proj["x"]), int(proj["y"])), int(r*0.6))

        # Draw LOCAL projectiles (Fix for bullet visibility)
        for proj in self.projectiles:
            proj.draw(self.virtual_screen)

        # Draw UI
        self.draw_ui()
        
        # Scale the entire virtual screen to the actual screen size
        scaled_frame = pygame.transform.scale(self.virtual_screen, (self.screen_width, self.screen_height))
        self.screen.blit(scaled_frame, (0, 0))
        
        pygame.display.flip()
    
    def draw_ui(self):
        # Player health
        health_text = self.font.render(f"Health: {int(self.player.health)}", True, (0, 255, 0))
        self.virtual_screen.blit(health_text, (20, 20))
        
        # Ammo
        ammo_text = self.font.render(f"Ammo: {self.player.ammo}/{self.player.max_ammo}", True, (255, 255, 0))
        self.virtual_screen.blit(ammo_text, (20, 60))
        
        # Super meter
        super_text = self.font.render(f"Super: {int(self.player.super_meter)}%", True, (0, 150, 255))
        self.virtual_screen.blit(super_text, (20, 100))
        
        # Super Bar
        bar_w = 150
        bar_h = 10
        pygame.draw.rect(self.virtual_screen, (50, 50, 50), (20, 135, bar_w, bar_h))
        pygame.draw.rect(self.virtual_screen, (0, 150, 255), (20, 135, bar_w * (self.player.super_meter/100.0), bar_h))
        
        if self.player.health <= 0:
             respawn_text = self.large_font.render("RESPAWNING...", True, (255, 0, 0))
             self.virtual_screen.blit(respawn_text, (self.WORLD_WIDTH//2 - 200, self.WORLD_HEIGHT//2))
        
        # Mode-specific UI (Knockout walls etc)
        self.mode.draw_ui(self.virtual_screen, self.font, self.player, [])


    
    def run(self):
        while self.running:
            self.handle_input()
            self.update()
            self.draw()
            self.clock.tick(self.fps)

