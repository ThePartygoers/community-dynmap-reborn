import concurrent.futures
import requests
import hashlib
import pymongo
import dotenv
import json
import time
import os
import sys
import math

dotenv.load_dotenv()

from multiprocessing import shared_memory
from PIL import Image, UnidentifiedImageError
from io import BytesIO
from tqdm import tqdm
import numpy as np

DL_WORKERS = 100
LOD_WORKERS = 8
SEARCH_RADIUS = 25
ROOT_TILE_SIZE = 500
TARGET_TILE_SIZE = 1024
LEVELS_OF_DETAIL = 3

MONGO_DB = "sauron"
MONGO_COLLECTION = "lands"

OUTPUT = "./src/static"

SERVERS = [
    "https://map.stoneworks.gg/abex1/maps/abex_1/",
    "https://map.stoneworks.gg/abex2/maps/abex_2/",
    "https://map.stoneworks.gg/abex3/maps/abex_3/",
    "https://map.stoneworks.gg/abex4/maps/abex_4/",
]

BAD_HASHES = [
    "177b12f5a598d27bbcda7e9d1865a7f097410f8f4bba1baae12788370bc7683a",
    "9762bfa0d2fdc78e208b02a1edf56c969fb155f27bcae59c6bd7b0e3ee81c30f",
    "d250c400195d32107d35c1ec97adcfb368265646fcfba518dc3c48ace3ac84b9",
    "7bba42e8d2bced01308221ac6952c8a63ebc9292ce3b79bab80a13bf969fad5d",
    "372a4ed627ea58bf55de2df3f25f15b19d7199641e5283396972ebd3e6a99231",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
]

tile = lambda base, lod, x, z: base + f"tiles/{lod}/x{x}/z{z}.png"

canvas_shape = (SEARCH_RADIUS * 2 * ROOT_TILE_SIZE, SEARCH_RADIUS * 2 * ROOT_TILE_SIZE, 4)
map_clr = np.zeros(canvas_shape, dtype=np.uint8)
map_alpha = np.zeros(canvas_shape, dtype=np.uint8)

def merge(source, destination):
    for key, value in source.items():
        if isinstance(value, dict):
            node = destination.setdefault(key, {})
            merge(value, node)
        else:
            destination[key] = value

    return destination

def dl(remote, x, y):
    try:
        response = requests.get(remote, timeout=10)
        response.raise_for_status()
    except Exception:
        return

    digest = hashlib.sha256(response.content).hexdigest()
    if digest in BAD_HASHES:
        return

    try:
        image = Image.open(BytesIO(response.content)).convert("RGBA")
    except UnidentifiedImageError:
        print("Failed to decode", remote, digest)
        with open("dump", "wb") as fh:
            fh.write(response.content)
    arr = np.transpose(np.array(image), (1, 0, 2))  # shape: (h, w, 4)

    x_dst = (x + SEARCH_RADIUS) * ROOT_TILE_SIZE
    y_dst = (y + SEARCH_RADIUS) * ROOT_TILE_SIZE

    crop = arr[:ROOT_TILE_SIZE, :ROOT_TILE_SIZE]
    alpha = crop[:, :, 3]
    mask = alpha > 0

    # color
    map_clr[x_dst:x_dst+ROOT_TILE_SIZE, y_dst:y_dst+ROOT_TILE_SIZE][mask] = crop[mask]

    # alpha
    extra = arr[:ROOT_TILE_SIZE, ROOT_TILE_SIZE+1:ROOT_TILE_SIZE*2+1]
    if extra.shape[1] >= ROOT_TILE_SIZE:
        map_alpha[x_dst:x_dst+ROOT_TILE_SIZE, y_dst:y_dst+ROOT_TILE_SIZE][mask] = extra[:, :ROOT_TILE_SIZE][mask]

def process_tile(server, lod, x, z):
    dl(tile(server, lod, x, z), x, z)

def compute_maps():
    alpha_R = map_alpha[..., 0]
    alpha_G = map_alpha[..., 1]
    alpha_B = map_alpha[..., 2]
    alpha_A = map_alpha[..., 3]

    # heightmap
    scaled_height = alpha_G * (255/320) + alpha_B * (1/320)
    height_norm = np.clip(scaled_height * 255, 0, 255).astype(np.uint8)
    grayscale_rgb = np.repeat(height_norm[..., None], 3, axis=-1)
    heightmap_alpha = np.dstack([grayscale_rgb, alpha_A])

    # lightmap
    light_rgb = np.clip(alpha_R * 10, 0, 255).astype(np.uint8)
    lightmap = np.repeat(light_rgb[..., None], 3, axis=-1)
    lightmap_alpha = np.dstack([lightmap, alpha_A])

    return heightmap_alpha, lightmap_alpha

def dump_maps(heightmap_alpha, lightmap_alpha, dir):
    os.makedirs(dir, exist_ok=True)
    Image.fromarray(np.transpose(map_clr, (1, 0, 2)), mode="RGBA").save(f"{dir}/output+color.png")
    Image.fromarray(heightmap_alpha, mode="RGBA").save(f"{dir}/output+alpha.png")
    Image.fromarray(lightmap_alpha, mode="RGBA").save(f"{dir}/output+red.png")

def generate_lod_tile_shared(x, z, name, lod, source_size, useful_radius, world_radius,
                            shm_name, shape, dtype):
    # Attach to shared memory
    existing_shm = shared_memory.SharedMemory(name=shm_name)
    array = np.ndarray(shape, dtype=dtype, buffer=existing_shm.buf)
    
    slice = array[x:x+source_size, z:z+source_size]
    image = Image.fromarray(slice, mode="RGBA").resize(
        (TARGET_TILE_SIZE, TARGET_TILE_SIZE), Image.Resampling.NEAREST
    )

    x_world = (x - useful_radius) // source_size
    z_world = (z - useful_radius) // source_size
    out_path = f"{OUTPUT}/maps/{name}/{lod}/{x_world}"
    os.makedirs(out_path, exist_ok=True)
    image.save(f"{out_path}/{z_world}.png")

    existing_shm.close()

def main():

    if not os.path.exists("src"):
        print("You must run this from project root")
        exit(1)


    mongodb = pymongo.MongoClient(os.environ["MDB"])[MONGO_DB][MONGO_COLLECTION]

    data = {}

    def process_markers(server):
        url = server + "live/markers.json?0"

        response = requests.get(url)

        if response.status_code == 200:
            return response.json()

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(SERVERS)) as executor:
            futures = [
                executor.submit(process_markers, server)
                for server in SERVERS
            ]
            for f in tqdm(concurrent.futures.as_completed(futures), total=len(futures), desc="Downloading Markers"):
                data = merge(data, f.result())

    except KeyboardInterrupt:
        executor.shutdown()
        raise

    data = { v["label"]:v for _,v in data["me.angeschossen.lands"]["markers"].items() }

    cursor = mongodb.find({
        "name": { "$in": [x["label"] for x in data.values()] }
    })

    final_output = {}
    for document in tqdm(cursor, desc="Reading MongoDB"):
        id = str(document["_id"])

        document["shape"] = data[document["name"]]["shape"]
        document["fillColor"] = data[document["name"]]["fillColor"]

        del document["_id"]

        final_output[id] = document

    with open(OUTPUT + "/" + "claims.json", "w") as fh:
        fh.write(json.dumps({
            "claims": final_output,
            "timestamp": math.floor(time.time() * 1000)
        }))

    # Download tiles
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=DL_WORKERS) as executor:
            futures = [
                executor.submit(process_tile, server, 1, x, z)
                for server in SERVERS
                for x in range(-SEARCH_RADIUS, SEARCH_RADIUS)
                for z in range(-SEARCH_RADIUS, SEARCH_RADIUS)
            ]
            for f in tqdm(concurrent.futures.as_completed(futures), total=len(futures), desc="Downloading tiles"):
                f.result()
    except KeyboardInterrupt:
        executor.shutdown()
        raise

    print("Processing layers...")
    heightmap_alpha, lightmap_alpha = compute_maps()

    shm_map_clr = shared_memory.SharedMemory(create=True, size=map_clr.nbytes)
    shm_height = shared_memory.SharedMemory(create=True, size=heightmap_alpha.nbytes)
    shm_light = shared_memory.SharedMemory(create=True, size=lightmap_alpha.nbytes)

    np_map_clr_shm = np.ndarray(map_clr.shape, dtype=map_clr.dtype, buffer=shm_map_clr.buf)
    np_map_clr_shm[:] = np.transpose(map_clr, (1, 0, 2))[:]

    heightmap_alpha = np.transpose(heightmap_alpha, (1, 0, 2))
    lightmap_alpha = np.transpose(lightmap_alpha, (1, 0, 2))

    np_height_shm = np.ndarray(heightmap_alpha.shape, dtype=heightmap_alpha.dtype, buffer=shm_height.buf)
    np_height_shm[:] = heightmap_alpha[:]

    np_light_shm = np.ndarray(lightmap_alpha.shape, dtype=lightmap_alpha.dtype, buffer=shm_light.buf)
    np_light_shm[:] = lightmap_alpha[:]

    if len(sys.argv) == 3 and sys.argv[1] == "--dumpfull":
        dump_maps(heightmap_alpha, lightmap_alpha, sys.argv[2])

    world_radius = SEARCH_RADIUS * ROOT_TILE_SIZE
    useful_radius = (world_radius // TARGET_TILE_SIZE) * TARGET_TILE_SIZE

    # LOD generation
    def generate_all_lods_shared():
        tasks = []
        shared_arrays = {
            "bluemap": (shm_map_clr.name, map_clr.shape, map_clr.dtype),
            "bluemap_height": (shm_height.name, heightmap_alpha.shape, heightmap_alpha.dtype),
            "bluemap_light": (shm_light.name, lightmap_alpha.shape, lightmap_alpha.dtype),
        }

        for lod in range(LEVELS_OF_DETAIL):
            source_size = math.floor(TARGET_TILE_SIZE * 2 ** lod)
            logical_origin = world_radius - useful_radius
            logical_end = world_radius + useful_radius + source_size

            for x in range(logical_origin, logical_end, source_size):
                for z in range(logical_origin, logical_end, source_size):
                    for name in ["bluemap", "bluemap_height", "bluemap_light"]:
                        shm_name, shape, dtype = shared_arrays[name]
                        tasks.append((x, z, name, lod, source_size, useful_radius, world_radius,
                                    shm_name, shape, dtype))
        return tasks

    with concurrent.futures.ProcessPoolExecutor(max_workers=LOD_WORKERS) as executor:
        futures = [
            executor.submit(generate_lod_tile_shared, *args)
            for args in generate_all_lods_shared()
        ]
        for f in tqdm(concurrent.futures.as_completed(futures), total=len(futures), desc="Generating LODs"):
            f.result()

    shm_map_clr.close()
    shm_map_clr.unlink()

    shm_height.close()
    shm_height.unlink()

    shm_light.close()
    shm_light.unlink()

    with open(OUTPUT + "/" + "meta.json", "w") as fh:
        fh.write(json.dumps({
            "maps": [
                {
                    "id": "bluemap",
                    "name": "Bluemap",
                    "desc": "Generated from the official Stoneworks Bluemap",
                    "timestamp": math.floor(time.time() * 1000)
                },
                {
                    "id": "bluemap_height",
                    "name": "Bluemap Heightmap",
                    "desc": "Generated from the official Stoneworks Bluemap",
                    "timestamp": math.floor(time.time() * 1000)
                },
                {
                    "id": "bluemap_light",
                    "name": "Bluemap Lightmap",
                    "desc": "Generated from the official Stoneworks Bluemap",
                    "timestamp": math.floor(time.time() * 1000)
                }
            ],
            "timestamp": math.floor(time.time())
        }))

if __name__ == "__main__":
    start = time.time()
    main()
    dt = time.time() - start
    print(f"Took {dt} secconds" )
