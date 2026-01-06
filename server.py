import socket
from _thread import *
import pickle
import time
import random

server = ""
port = 5555

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

try:
    s.bind((server, port))
except socket.error as e:
    str(e)

s.listen(4)
print("Waiting for a connection, Server Started")

# Game State
players = {}
# dead_players: {player_id: death_timestamp}
dead_players = {}

# Simple counter for player IDs
current_id_counter = 0

# Wall rectangles (x, y, w, h) - MUST MATCH src/modes.py Knockout walls
# center_x = 960, center_y = 540
WALL_RECTS = [
    (960 - 300, 540 - 250, 120, 150), # Top-left
    (960 + 180, 540 - 250, 120, 150), # Top-right
    (960 - 300, 540 + 100, 120, 150), # Bottom-left
    (960 + 180, 540 + 100, 120, 150), # Bottom-right
    (960 - 80, 540 - 120, 160, 80),  # Top-center
    (960 - 80, 540 + 40, 160, 80)    # Bottom-center
]

def is_colliding_with_walls(x, y, radius):
    for rx, ry, rw, rh in WALL_RECTS:
        # Find closest point on rect to circle center
        closest_x = max(rx, min(x, rx + rw))
        closest_y = max(ry, min(y, ry + rh))
        
        # Calculate distance
        dist = ((x - closest_x)**2 + (y - closest_y)**2)**0.5
        if dist < radius + 5: # 5px buffer
            return True
    return False

def get_safe_spawn():
    while True:
        x = random.randint(100, 1820)
        y = random.randint(100, 980)
        if not is_colliding_with_walls(x, y, 25): # Player radius is 25
            return x, y

def threaded_client(conn, p_id):
    global players
    
    # Initial safe spawn
    start_pos_x, start_pos_y = get_safe_spawn()
    
    # 0=x, 1=y, 2=color, 3=is_alive, 4=health, 5=player_id, 6=angle
    players[p_id] = {
        "x": start_pos_x,
        "y": start_pos_y,
        "color": (random.randint(0,255), random.randint(0,255), random.randint(0,255)),
        "alive": True,
        "health": 100,
        "id": p_id,
        "angle": 0,
        "super_charge": 0,
        "last_damage_time": time.time(),
        "projectiles": [] 
    }
    
    conn.send(pickle.dumps(players[p_id]))
    
    last_update_time = time.time()
    
    while True:
        try:
            current_time = time.time()
            dt = current_time - last_update_time
            last_update_time = current_time
            
            data = pickle.loads(conn.recv(2048*4))
            
            if not data:
                print("Disconnected")
                break
            else:
                # Update player state from client
                if players[p_id]["alive"]:
                    players[p_id]["x"] = data["x"]
                    players[p_id]["y"] = data["y"]
                    players[p_id]["angle"] = data.get("angle", 0)
                    players[p_id]["projectiles"] = data["projectiles"]
                    
                    # Authority Hit Reg: Server checks if any projectile hits any OTHER player
                    for my_proj in players[p_id]["projectiles"][:]:
                        hit_detected = False
                        is_super = my_proj.get("is_super", False)
                        
                        # Reset super charge if a super was fired
                        if is_super:
                            players[p_id]["super_charge"] = 0
                        
                        for other_id in players:
                            if other_id != p_id and players[other_id]["alive"]:
                                other_p = players[other_id]
                                dist = ((my_proj["x"] - other_p["x"])**2 + (my_proj["y"] - other_p["y"])**2)**0.5
                                
                                # Hitbox check
                                hit_radius = 40 if is_super else 35
                                if dist < hit_radius:
                                    damage = 100 if is_super else 25
                                    players[other_id]["health"] -= damage
                                    players[other_id]["last_damage_time"] = current_time
                                    
                                    if not is_super:
                                        hit_detected = True
                                        # Charge super on normal hits
                                        players[p_id]["super_charge"] = min(100, players[p_id]["super_charge"] + 25)
                                    
                                    if players[other_id]["health"] <= 0:
                                        players[other_id]["alive"] = False
                                        players[other_id]["health"] = 0
                                        dead_players[other_id] = current_time
                                    
                                    if not is_super: break # Standard bullet hits one
                        
                        if hit_detected:
                            players[p_id]["projectiles"].remove(my_proj)
                    
                    # Process healing for this player
                    if players[p_id]["health"] < 100:
                        time_since_hit = current_time - players[p_id]["last_damage_time"]
                        if time_since_hit > 2.0:
                            # Accelerating healing: faster the longer you wait
                            # Slowed down by 2x: (2.5 base + accelerant / 2)
                            regen_speed = 2.5 + (time_since_hit - 2.0)**2 * 5
                            players[p_id]["health"] = min(100, players[p_id]["health"] + regen_speed * dt)
                
                # Check for respawn
                if not players[p_id]["alive"]:
                     if p_id in dead_players:
                        if current_time - dead_players[p_id] > 5: # 5 seconds
                            players[p_id]["alive"] = True
                            players[p_id]["health"] = 100
                            players[p_id]["super_charge"] = 0
                            players[p_id]["last_damage_time"] = current_time
                            safe_x, safe_y = get_safe_spawn()
                            players[p_id]["x"] = safe_x
                            players[p_id]["y"] = safe_y
                            del dead_players[p_id]

                # Send back ALL players data
                reply = players
                conn.sendall(pickle.dumps(reply))
        except:
            break

    print("Lost connection")
    try:
        del players[p_id]
        if p_id in dead_players:
            del dead_players[p_id]
    except:
        pass
    conn.close()

while True:
    conn, addr = s.accept()
    print("Connected to:", addr)

    start_new_thread(threaded_client, (conn, current_id_counter))
    current_id_counter += 1
