IN = lambda b: -1500 <= b[0] and b[3] <= 1500 and -4700 <= b[1] and b[4] <= 3300 and -500 <= b[2] and b[5] <= 3300
keep = lambda i, b: IN(b)
UP = (0, 0, 1)
VIEWS = [
    dict(name="t_rear", dir=(-1.0, 1.3, .75), up=UP, keep=keep),
    dict(name="t_front", dir=(-1.0, -1.3, .75), up=UP, keep=keep),
    dict(name="t_side", dir=(-1, 0, 0), up=UP, keep=keep),
]
def near(box, m=20):
    return lambda i, b: IN(b) and b[0] <= box[3] + m and b[3] >= box[0] - m and b[1] <= box[4] + m and b[4] >= box[1] - m and b[2] <= box[5] + m and b[5] >= box[2] - m
SIDE = (-1, .35, .3)
C = dict(
    tz_door=((-1100, -1500, 650, -800, 20, 3100), SIDE),
    tz_latch=((-1100, -900, 1450, -800, -500, 2100), SIDE),
    tz_hitch=((-500, -4600, -100, 500, -2700, 1000), (-1, -.8, .7)),
    tz_wheel=((-1300, -1500, -350, -700, 800, 900), (-1, .25, .25)),
    tz_rear=((-1300, 2600, -400, 1300, 3300, 3200), (0, 1, .05)),
)
VIEWS += [dict(name=k, dir=d, up=UP, keep=near(c), crop=c, defl=.4) for k, (c, d) in C.items()]
for v in VIEWS: v["sw"] = None
# cut-away side view with three load blocks (trailer_load.brep = trailer.brep + boxes, see README)
VIEWS += [dict(name="t_load", dir=(-1, 0, 0), up=UP, keep=lambda i, b: IN(b) and not (b[3] < -860 and b[5] > 700))]
