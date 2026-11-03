using System.Buffers.Binary;
using System.IO.Compression;

// RGB565 -> PNG (8-bit RGB, no interlace) with the BCL only: GetVirtualSystemThumbnailImage returns raw RGB565, and System.Drawing is neither part of
// the shared framework's trusted surface here nor needed. The output is valid for any PNG reader: signature, IHDR, one IDAT (zlib), IEND, CRC-32 per chunk.
internal static class PngEncoder
{
    private static readonly byte[] Signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly uint[] CrcTable = BuildCrcTable();

    /// <summary>`pixels` is width * height little-endian RGB565 values, rows packed without padding.</summary>
    public static byte[] FromRgb565(ReadOnlySpan<byte> pixels, int width, int height)
    {
        if (width < 1 || height < 1 || pixels.Length != checked(width * height * 2)) throw new ArgumentException("rgb565_size");
        using MemoryStream png = new();
        png.Write(Signature);
        WriteChunk(png, "IHDR"u8, Header(width, height));
        WriteChunk(png, "IDAT"u8, Compress(pixels, width, height));
        WriteChunk(png, "IEND"u8, []);
        return png.ToArray();
    }

    private static byte[] Header(int width, int height)
    {
        byte[] header = new byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(4), (uint)height);
        header[8] = 8; // bit depth
        header[9] = 2; // colour type: truecolour RGB; compression, filter and interlace stay 0
        return header;
    }

    private static byte[] Compress(ReadOnlySpan<byte> pixels, int width, int height)
    {
        using MemoryStream compressed = new();
        using (ZLibStream zlib = new(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            byte[] row = new byte[1 + width * 3]; // row[0] is the filter type: 0 = none
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++) ExpandPixel(BinaryPrimitives.ReadUInt16LittleEndian(pixels[((y * width + x) * 2)..]), row.AsSpan(1 + x * 3, 3));
                zlib.Write(row);
            }
        }
        return compressed.ToArray();
    }

    // 5/6/5 bits to 8: the top bits are repeated into the low bits so that full intensity maps to 255.
    private static void ExpandPixel(ushort value, Span<byte> rgb)
    {
        int red = value >> 11, green = (value >> 5) & 0x3F, blue = value & 0x1F;
        rgb[0] = (byte)((red << 3) | (red >> 2));
        rgb[1] = (byte)((green << 2) | (green >> 4));
        rgb[2] = (byte)((blue << 3) | (blue >> 2));
    }

    private static void WriteChunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> number = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(number, (uint)data.Length);
        output.Write(number);
        output.Write(type);
        output.Write(data);
        uint crc = Crc32(Crc32(0, type), data);
        BinaryPrimitives.WriteUInt32BigEndian(number, crc);
        output.Write(number);
    }

    // Standard CRC-32 (reflected, polynomial 0xEDB88320). `crc` is the value of the bytes so far, so the type and the data are chained.
    private static uint Crc32(uint crc, ReadOnlySpan<byte> bytes)
    {
        uint state = ~crc;
        foreach (byte b in bytes) state = CrcTable[(state ^ b) & 0xFF] ^ (state >> 8);
        return ~state;
    }

    private static uint[] BuildCrcTable()
    {
        uint[] table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }
}
