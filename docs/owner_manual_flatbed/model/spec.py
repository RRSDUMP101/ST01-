IN = lambda b: -1500 <= b[0] and b[3] <= 1500 and -700 <= b[1] and b[4] <= 1000 and -1100 <= b[2] and b[5] <= 1100
TG = lambda i, b: b[0] >= 1215 and b[1] >= 0 and b[4] <= 310 and b[2] >= -935 and b[5] <= 935
SG = lambda i, b: b[1] >= 15 and b[4] <= 310 and b[2] >= 900 and b[0] >= -1330 and b[3] <= 1290
LEV = lambda i, b: i in (196, 199)
keep = lambda i, b: IN(b)
def near(box, m=30):
    return lambda i, b: IN(b) and b[0] <= box[3] + m and b[3] >= box[0] - m and b[1] <= box[4] + m and b[4] >= box[1] - m and b[2] <= box[5] + m and b[5] >= box[2] - m
REAR = (1, .7, 1.2); FRONT = (-1, .8, 1.1); LOWSIDE = (.25, .35, 1)
LEVBOX = (1200, 60, 860, 1400, 330, 1100)
VIEWS = [
    dict(name="iso", dir=REAR, keep=keep),
    dict(name="tg90", dir=REAR, keep=keep, rot=[(TG, (1273, 3, 0), (0, 0, 1), -90)]),
    dict(name="tg180", dir=REAR, keep=keep, rot=[(TG, (1273, 3, 0), (0, 0, 1), -180)]),
    dict(name="sg90", dir=REAR, keep=keep, rot=[(SG, (0, 10, 982), (1, 0, 0), 90)]),
    dict(name="top", dir=(0, 1, 0), up=(-1, 0, 0), keep=keep),
    dict(name="side", dir=(0, 0, 1), keep=keep),
    dict(name="front_iso", dir=FRONT, keep=keep),
    dict(name="z_lever", dir=REAR, keep=near(LEVBOX), crop=LEVBOX, defl=.2),
    dict(name="z_lever_open", dir=REAR, keep=near(LEVBOX), crop=LEVBOX, defl=.2, rot=[(LEV, (0, 272, 961), (1, 0, 0), -75)]),
    dict(name="z_latch", dir=REAR, keep=near((1060, 180, 880, 1230, 360, 1040)), crop=(1060, 180, 880, 1230, 360, 1040), defl=.2),
    dict(name="z_head", dir=FRONT, keep=near((-1480, 0, -1000, -1250, 950, 1060)), crop=(-1480, 0, -1000, -1250, 950, 1060), defl=.4),
    dict(name="z_hinge_tg", dir=(1, .25, .5), keep=near((1180, -120, -1000, 1340, 120, 1060)), crop=(1180, -120, -1000, 1340, 120, 1060), defl=.4),
    dict(name="z_hinge_sg", dir=LOWSIDE, keep=near((-1450, -120, 880, 1300, 120, 1060)), crop=(-1450, -120, 880, 1300, 120, 1060), defl=.4),
    dict(name="z_mud", dir=LOWSIDE, keep=near((-900, -560, 640, 560, 60, 1060)), crop=(-900, -560, 640, 560, 60, 1060), defl=.4),
]
for v in VIEWS:
    if "crop" in v: v["sw"] = None
