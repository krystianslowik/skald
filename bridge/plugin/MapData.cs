using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace Skald.Bridge
{
    // Codec for the cartography table's shared map blob (the table ZDO's "data"
    // byte array). The layout was read from saved worlds, not from game code:
    //
    //   gzip(
    //     i32 version (3)
    //     i32 n = size*size (2048*2048), then n bytes explored (0/1),
    //         row = z/12 + 1024, col = x/12 + 1024
    //     i32 pinCount, then per pin:
    //         i64 owner, string name, f32 x, f32 y, f32 z, i32 type,
    //         u8 checked, string author
    //     [anything after the pins is kept verbatim])
    //
    // Strings use the .NET BinaryWriter format (7-bit length prefix + UTF-8).
    // Pure .NET on purpose: no Unity types, so it is unit-tested off the game.
    public sealed class MapData
    {
        public const int SupportedVersion = 3;

        public sealed class Pin
        {
            public long Owner;
            public string Name = "";
            public float X, Y, Z;
            public int Type;
            public bool Checked;
            public string Author = "";
        }

        public int Version = SupportedVersion;
        public byte[] Explored = new byte[0];
        public List<Pin> Pins = new List<Pin>();
        public byte[] Trailing = new byte[0];

        public int Size => (int)Math.Round(Math.Sqrt(Explored.Length));

        public static MapData Decode(byte[] gz)
        {
            if (gz == null || gz.Length == 0) throw new InvalidDataException("empty map data");
            byte[] raw;
            using (var src = new GZipStream(new MemoryStream(gz), CompressionMode.Decompress))
            using (var dst = new MemoryStream())
            {
                src.CopyTo(dst);
                raw = dst.ToArray();
            }
            using (var r = new BinaryReader(new MemoryStream(raw), Encoding.UTF8))
            {
                var m = new MapData { Version = r.ReadInt32() };
                if (m.Version != SupportedVersion)
                    throw new NotSupportedException("map data version " + m.Version + " (supported: " + SupportedVersion + ")");
                int n = r.ReadInt32();
                long left = raw.Length - r.BaseStream.Position;
                if (n < 0 || n > left) throw new InvalidDataException("explored length " + n + " exceeds data");
                m.Explored = r.ReadBytes(n);
                int pins = r.ReadInt32();
                if (pins < 0 || pins > 100000) throw new InvalidDataException("pin count " + pins);
                for (int i = 0; i < pins; i++)
                {
                    m.Pins.Add(new Pin
                    {
                        Owner = r.ReadInt64(),
                        Name = r.ReadString(),
                        X = r.ReadSingle(), Y = r.ReadSingle(), Z = r.ReadSingle(),
                        Type = r.ReadInt32(),
                        Checked = r.ReadByte() != 0,
                        Author = r.ReadString(),
                    });
                }
                m.Trailing = r.ReadBytes((int)(raw.Length - r.BaseStream.Position));
                return m;
            }
        }

        public byte[] Encode()
        {
            var raw = new MemoryStream();
            using (var w = new BinaryWriter(raw, Encoding.UTF8, true))
            {
                w.Write(Version);
                w.Write(Explored.Length);
                w.Write(Explored);
                w.Write(Pins.Count);
                foreach (var p in Pins)
                {
                    w.Write(p.Owner);
                    w.Write(p.Name ?? "");
                    w.Write(p.X); w.Write(p.Y); w.Write(p.Z);
                    w.Write(p.Type);
                    w.Write((byte)(p.Checked ? 1 : 0));
                    w.Write(p.Author ?? "");
                }
                w.Write(Trailing);
            }
            var gz = new MemoryStream();
            using (var z = new GZipStream(gz, CompressionMode.Compress, true))
                z.Write(raw.GetBuffer(), 0, (int)raw.Length);
            return gz.ToArray();
        }

        // Marks every pixel explored. Returns how many were newly revealed.
        public int RevealAll()
        {
            int added = 0;
            for (int i = 0; i < Explored.Length; i++)
                if (Explored[i] == 0) { Explored[i] = 1; added++; }
            return added;
        }

        // Adds pins, skipping any that already exist with the same name within
        // 1 m (so a repeated call does not duplicate them). Returns how many were added.
        public int AddPins(IEnumerable<Pin> pins)
        {
            int added = 0;
            foreach (var p in pins)
            {
                bool dup = Pins.Exists(e => e.Name == p.Name
                    && Math.Abs(e.X - p.X) < 1f && Math.Abs(e.Z - p.Z) < 1f);
                if (dup) continue;
                Pins.Add(p);
                added++;
            }
            return added;
        }
    }
}
