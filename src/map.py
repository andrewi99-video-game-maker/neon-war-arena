import pygame

class Wall:
    """A wall that blocks movement and projectiles"""
    def __init__(self, x, y, width, height):
        self.rect = pygame.Rect(x, y, width, height)
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    
    def draw(self, surface):
        pygame.draw.rect(surface, (150, 100, 50), self.rect)
        pygame.draw.rect(surface, (200, 150, 100), self.rect, 3)
    
    def collides_with_point(self, x, y, radius):
        """Check if a circle centered at (x, y) collides with this wall"""
        # Find closest point on rect to circle center
        closest_x = max(self.rect.left, min(x, self.rect.right))
        closest_y = max(self.rect.top, min(y, self.rect.bottom))
        
        # Calculate distance between circle center and closest point
        distance_x = x - closest_x
        distance_y = y - closest_y
        distance = (distance_x ** 2 + distance_y ** 2) ** 0.5
        
        return distance < radius
    
    def get_collision_response(self, x, y, radius):
        """Get a safe position if the circle overlaps this wall"""
        # Find closest point on rect to circle center
        closest_x = max(self.rect.left, min(x, self.rect.right))
        closest_y = max(self.rect.top, min(y, self.rect.bottom))
        
        # Calculate distance and direction
        distance_x = x - closest_x
        distance_y = y - closest_y
        distance = (distance_x ** 2 + distance_y ** 2) ** 0.5
        
        if distance == 0:
            distance = 1
        
        # Move away from wall
        new_x = x + (distance_x / distance) * (radius - distance + 5)
        new_y = y + (distance_y / distance) * (radius - distance + 5)
        
        return new_x, new_y

class Map:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.obstacles = [
            pygame.Rect(400, 300, 200, 150),
            pygame.Rect(self.width - 600, 400, 150, 200),
            pygame.Rect(self.width // 2 - 100, self.height - 300, 200, 150),
        ]
    
    def draw(self, surface):
        # Draw obstacles
        for obstacle in self.obstacles:
            pygame.draw.rect(surface, (100, 100, 100), obstacle)
            pygame.draw.rect(surface, (150, 150, 150), obstacle, 3)
        
        # Draw grid background
        grid_size = 50
        for x in range(0, self.width, grid_size):
            pygame.draw.line(surface, (60, 60, 60), (x, 0), (x, self.height), 1)
        for y in range(0, self.height, grid_size):
            pygame.draw.line(surface, (60, 60, 60), (0, y), (self.width, y), 1)
